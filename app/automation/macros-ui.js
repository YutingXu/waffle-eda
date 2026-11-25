"use strict";
// Macros: a dock panel with the workspace catalogue and, in place of the list, the macro
// editor. Recording shows in the status bar (AtriumIntelUI). Replays preview their steps
// and changes in the shared review sheet and apply as one Undo step, or step by step
// with one review per step.
globalThis.AtriumMacrosUI = (() => {
  const G = globalThis, B = G.AtriumButter, U = G.AtriumIntelUI, K = G.AtriumUIKit;
  const host = () => G.AtriumNavHost;
  const P = "butter.macros.";
  const apply = (id, args = {}) => G.AtriumButterEditor.apply(P + id, args);
  const read = async (id, args = {}) => (await B.run(P + id, args, {mode:"read"})).result;
  const TYPES = ["number", "string", "integer", "boolean", "array", "object"];
  let panel, recordButton, editing = null, outcome = null, recording = {status:"idle", count:0}, lastDraft = null, workspaceName = "";

  // ------------------------------------------------------------------ catalogue
  function commandTitle(id) {
    const match = /^butter\.([a-zA-Z0-9]+)\.(.+)$/.exec(id);
    const spec = match && G.AtriumButterCatalog?.[match[1]]?.commands.find(c => c.id === match[2]);
    return spec?.title ?? G.AtriumKeymap?.command?.(id)?.title ?? id;
  }
  function available(id) {
    try { B.resolve(id, "macro"); return true; } catch { return false; }
  }
  function shortcut(binding) {
    if (!binding) return null;
    try { return G.AtriumShortcut.render(binding, {variant:"inline"}); } catch { return K.el("span", "ui-row-meta", binding); }
  }
  async function renderCatalogue() {
    const {records} = await read("list");
    const out = [];
    if (outcome) out.push(outcome);
    if (lastDraft && !lastDraft.steps.length) out.push(K.notice({title:"Nothing recorded.", text:"Run commands from the palette, change a track width or run DRC while recording."}));
    if (!records.length) {
      out.push(K.empty({title:"No macros yet", text:"Record a few commands, then name the macro and give it an alias or a shortcut.",
        actions:[K.button("Record", {variant:"primary", size:"sm", run:toggleRecording}), K.button("Import…", {size:"sm", run:importRecord})], centred:true}));
      return out;
    }
    const rows = records.map(m => {
      const missing = m.steps.filter(s => !available(s.command));
      const detail = [m.alias, m.steps.length + (m.steps.length === 1 ? " step" : " steps"), m.selectionOnly && "needs a selection",
        missing.length && "uses " + commandTitle(missing[0].command) + ", which is off"].filter(Boolean).join(" · ");
      const row = K.row({title:m.name, detail, meta:shortcut(m.shortcut) ?? undefined, state:missing.length ? "broken" : undefined, role:"listitem",
        actions:[K.button("Run…", {variant:"quiet", size:"sm", disabled:!!missing.length, run:() => run(m)}),
          U.more("More actions for " + m.name, [{label:"Edit", run:() => edit(m)}, {label:"Step through…", enabled:!missing.length, run:() => run(m, {stepwise:true})},
            {label:"Export…", run:() => exportMacro(m)}, "-", {label:"Delete…", run:() => remove(m)}])]});
      row.tabIndex = 0;
      row.addEventListener("dblclick", () => edit(m));
      row.addEventListener("keydown", event => { if (event.key === "Enter" && event.target === row) edit(m); });
      return row;
    });
    out.push(K.section("Saved macros", {actions:[K.count(records.length), K.button("Import…", {variant:"quiet", size:"sm", run:importRecord})],
      note:"Macros belong to " + (workspaceName || "this workspace") + ". Aliases run from the / palette."}, K.list(rows, {role:"list", label:"Saved macros"})));
    return out;
  }

  // ------------------------------------------------------------------ recording
  async function toggleRecording() {
    try {
      if (recording.status === "recording") return stopRecording();
      await apply("record-start");
      outcome = null; lastDraft = null;
      U.refreshRecording();
      host().info("Recording. Use commands as usual, then choose Stop.");
    } catch (error) { host().info(error.message); }
  }
  async function stopRecording() {
    const {result} = await apply("record-stop");
    lastDraft = result;
    U.refreshRecording();
    await open();
    if (result.steps.length) edit({format:"waffle-macro", version:1, name:"Recorded macro", alias:"recorded-" + (Date.now() % 1000),
      parameters:[], steps:result.steps}, {draft:true, full:result.full});
    else render();
  }
  function recordingChanged(state) {
    recording = state;
    if (recordButton) { recordButton.textContent = state.status === "recording" ? "Stop" : "Record"; recordButton.setAttribute("aria-pressed", String(state.status === "recording")); }
  }

  // ------------------------------------------------------------------ editor
  // A working copy: the record fields, parameters and steps. Saving validates the whole
  // record with the same validator replay uses and shows its message where it applies.
  function edit(macro, {draft = false, imported = false, full = false} = {}) {
    editing = {macro:JSON.parse(JSON.stringify(macro)), draft, imported, full, error:null, open:new Set()};
    render();
  }
  function renderEditor() {
    const e = editing, m = e.macro, out = [];
    const badges = [];
    if (e.draft) badges.push(K.badge("Recorded", "accent"));
    if (e.imported) badges.push(K.badge("Imported", "info"));
    if (e.full) out.push(K.notice({tone:"warning", title:"Recording full.", text:"It stopped at its step limit. Later commands were not captured."}));
    if (e.error) out.push(K.notice({tone:"danger", title:e.error.title, text:e.error.message}));
    const name = K.field({value:m.name, label:"Name", onInput:value => { m.name = value; }});
    const alias = K.field({value:m.alias, label:"Alias", invalid:e.error?.field === "alias", onInput:value => { m.alias = value.trim(); }});
    const key = K.field({value:m.shortcut ?? "", label:"Shortcut", placeholder:"Ctrl+Alt+W", invalid:e.error?.field === "shortcut",
      onInput:value => { if (value.trim()) m.shortcut = value.trim(); else delete m.shortcut; }});
    const selection = K.switchRow("Needs a selection", {checked:!!m.selectionOnly, onChange:on => { m.selectionOnly = on; }});
    const form = K.el("div", "intel-macro-form");
    form.append(K.propRow("Name", name), K.propRow("Alias", alias, {error:e.error?.field === "alias" ? e.error.message : undefined}),
      K.propRow("Shortcut", key, {error:e.error?.field === "shortcut" ? e.error.message : undefined}), selection);
    const head = K.section(e.draft ? "New macro" : m.name || "Macro", {actions:badges}, form);
    out.push(head);
    // Parameters
    const params = (m.parameters ??= []).map((p, i) => {
      const row = K.el("div", "intel-step-actions");
      const n = K.field({value:p.name, label:"Parameter name", onInput:v => { p.name = v.trim(); }});
      const t = K.select(TYPES, {value:p.type, label:"Type", onChange:v => { p.type = v; }});
      const d = K.field({value:p.default === undefined ? "" : JSON.stringify(p.default), label:"Default", placeholder:"No default",
        onInput:v => { if (!v.trim()) delete p.default; else try { p.default = JSON.parse(v); } catch { p.default = v; } }});
      row.append(n, t, d, K.button("Remove", {variant:"quiet", size:"sm", run:() => { m.parameters.splice(i, 1); render(); }}));
      return row;
    });
    out.push(K.section("Parameters", {actions:[K.iconButton("plus", "Add parameter", {run:() => {
      m.parameters.push({name:"value-" + (m.parameters.length + 1), type:"number"}); render(); }})]},
      ...(params.length ? params : [K.el("p", "ui-section-note", "A parameter asks for a value each time the macro runs.")])));
    // Steps
    const stepRows = m.steps.map((s, i) => stepBlock(m, s, i));
    out.push(K.section("Steps", {actions:[K.count(m.steps.length)], note:"Select a step to edit its arguments. Alt+Up and Alt+Down reorder."},
      K.list(stepRows, {role:"tree", label:"Steps"})));
    const actions = K.el("div", "intel-step-actions");
    actions.append(K.button("Cancel", {size:"sm", run:() => { editing = null; render(); }}),
      K.button(e.draft || !m.id ? "Save macro" : "Save", {variant:"primary", size:"sm", run:save}));
    out.push(actions);
    return out;
  }
  function argumentText(value) {
    if (value && typeof value === "object" && "$parameter" in value) return "parameter " + value.$parameter;
    if (value && typeof value === "object" && "$context" in value) return value.$context === "selection" ? "the selection" : "the active document";
    const text = JSON.stringify(value);
    return text.length > 40 ? text.slice(0, 39) + "…" : text;
  }
  function stepBlock(m, step, i) {
    const known = available(step.command), open = editing.open.has(step.id ?? i);
    const args = Object.entries(step.args ?? {});
    const detail = step.when ? "Only when " + step.when.source + (step.when.match === false ? " has no matches" : " has matches") :
      args.map(([k, v]) => k + " " + argumentText(v)).join(" · ") || "No arguments";
    const move = (to) => { const [s] = m.steps.splice(i, 1); m.steps.splice(to, 0, s); render(); };
    const row = K.row({title:(i + 1) + ". " + commandTitle(step.command), detail:known ? detail : "Unavailable: this command is off or not in this build",
      state:known ? undefined : "broken", expanded:open, depth:0});
    row.addEventListener("click", event => {
      if (event.target.closest("button")) return;
      const key = step.id ?? i; editing.open.has(key) ? editing.open.delete(key) : editing.open.add(key); render();
    });
    row.addEventListener("keydown", event => {
      if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault(); const to = i + (event.key === "ArrowUp" ? -1 : 1); if (to >= 0 && to < m.steps.length) move(to);
      }
    });
    row.tabIndex = 0;
    if (!open) return row;
    const wrap = K.el("div");
    wrap.append(row);
    const fields = K.el("div", "intel-step-args");
    fields.append(K.toolbar([K.button("Up", {variant:"quiet", size:"sm", disabled:i === 0, run:() => move(i - 1)}),
      K.button("Down", {variant:"quiet", size:"sm", disabled:i === m.steps.length - 1, run:() => move(i + 1)}), "->",
      K.button("Remove", {variant:"quiet", size:"sm", run:() => { m.steps.splice(i, 1); render(); }})], {label:"Step " + (i + 1)}));
    const spec = (() => { try { return B.resolve(step.command, "macro").spec; } catch { return null; } })();
    const props = spec ? B.argumentSchema(spec).properties ?? {} : {};
    const names = [...new Set([...Object.keys(props), ...args.map(([k]) => k)])];
    for (const name of names) fields.append(argumentRow(m, step, name, props[name] ?? {}));
    const when = K.field({value:step.when?.source ?? "", label:"Condition query", placeholder:"track where width < 0.2 mm",
      onInput:v => { if (v.trim()) step.when = {source:v.trim(), match:step.when?.match ?? true}; else delete step.when; }});
    fields.append(K.propRow("Only when", when));
    if (!names.length) fields.prepend(K.el("p", "ui-section-note", "This command takes no arguments."));
    wrap.append(fields);
    return wrap;
  }
  // Each argument is a literal, a macro parameter or the selection or active document.
  function argumentRow(m, step, name, schema) {
    step.args ??= {};
    const value = step.args[name];
    const mode = value && typeof value === "object" && "$parameter" in value ? "p:" + value.$parameter :
      value && typeof value === "object" && "$context" in value ? "c:" + value.$context : value === undefined ? "unset" : "value";
    const choices = [["unset", "Not set"], ["value", "Value"], ...m.parameters.map(p => ["p:" + p.name, "Parameter " + p.name]),
      ["c:selection", "Selection"], ["c:documentId", "Active document"]];
    if (mode.startsWith("p:") && !m.parameters.some(p => "p:" + p.name === mode)) choices.push([mode, "Missing parameter " + mode.slice(2)]);
    const field = K.field({value:mode === "value" ? (typeof value === "string" ? value : JSON.stringify(value)) : "", label:name,
      type:schema.type === "number" || schema.type === "integer" ? "number" : "text", disabled:mode !== "value",
      onInput:v => { step.args[name] = schema.type === "number" || schema.type === "integer" ? Number(v) :
        schema.type === "string" ? v : (() => { try { return JSON.parse(v); } catch { return v; } })(); }});
    const source = K.select(choices, {value:mode, label:name + " source", onChange:v => {
      if (v === "unset") delete step.args[name];
      else if (v === "value") step.args[name] = schema.type === "number" ? 0 : "";
      else if (v.startsWith("p:")) step.args[name] = {$parameter:v.slice(2)};
      else step.args[name] = {$context:v.slice(2)};
      render();
    }});
    // Validated against the command's own schema when the value is committed, in place.
    const problem = () => {
      const now = step.args[name];
      if (mode.startsWith("p:") && !m.parameters.some(p => "p:" + p.name === mode)) return "Add parameter " + mode.slice(2) + " or choose another source.";
      if (mode !== "value") return null;
      try { B.validateArguments({type:"object", properties:{[name]:schema}}, {[name]:now}); return null; }
      catch (failure) { return failure.message.replace(/^args\./, ""); }
    };
    const box = K.el("span", "intel-step-value");
    box.append(source);
    if (mode === "value") box.append(field);
    const row = K.propRow(name, box, {error:problem() ?? undefined});
    field.addEventListener?.("change", () => {
      row.querySelector(":scope > .ui-prop-error")?.remove();
      const message = problem();
      if (message) row.append(K.el("span", "ui-prop-error", message));
      (field.matches?.("input") ? field : field.querySelector("input"))?.setAttribute("aria-invalid", String(!!message));
    });
    return row;
  }
  async function save() {
    const e = editing, m = e.macro;
    try {
      const record = G.AtriumMacros.record(m, true);
      const {result} = await apply("save", {macro:record});
      editing = null; lastDraft = null;
      outcome = K.notice({tone:"success", text:"Saved " + result.macro.name + ". Run it from the / palette as " + result.macro.alias + "."});
    } catch (error) {
      const message = error.message;
      e.error = {title:error.code === "alias_conflict" ? "Alias in use." : "Not saved.", message,
        field:error.code === "alias_conflict" || /alias/i.test(message) ? "alias" : /shortcut/i.test(message) ? "shortcut" : null};
    }
    render();
  }
  async function remove(m) {
    const d = G.AtriumShell.dialog({title:"Delete " + m.name + "?", body:[K.el("p", null, "Its alias and shortcut stop working in this workspace.")],
      actions:[{label:"Cancel", focus:true}, {label:"Delete", variant:"danger", default:false, run:async () => { await apply("remove", {id:m.id}); }}]});
    if (await d.done === "Delete") { outcome = null; render(); }
  }
  async function importRecord() {
    const text = K.el("textarea", "ui-field");
    text.rows = 8; text.setAttribute("aria-label", "Macro record"); text.placeholder = '{"format":"waffle-macro","version":1,…}';
    const message = K.el("p", "ui-prop-error");
    let record;
    const d = G.AtriumShell.dialog({title:"Import macro", body:[K.el("p", null, "Paste a portable macro record. It opens in the editor before anything is saved."), text, message],
      actions:[{label:"Cancel"}, {label:"Open in editor", primary:true, run:() => {
        try { record = G.AtriumMacros.record(JSON.parse(text.value), true); }
        catch (error) { message.textContent = error instanceof SyntaxError ? "This is not a macro record." : error.message; return false; }
      }}]});
    text.focus();
    if (await d.done === "Open in editor") { await open(); edit(record, {imported:true}); }
  }

  // ------------------------------------------------------------------ replay
  async function parameters(m) {
    if (!m.parameters?.length) return {};
    const values = {}, fields = m.parameters.map(p => {
      const f = K.field({value:p.default === undefined ? "" : String(p.default), label:p.name, type:p.type === "number" || p.type === "integer" ? "number" : "text"});
      return [p, f];
    });
    const message = K.el("p", "ui-prop-error");
    const d = G.AtriumShell.dialog({title:"Run " + m.name, body:[...fields.map(([p, f]) => K.propRow(p.name, f)), message],
      actions:[{label:"Cancel"}, {label:"Preview", primary:true, run:() => {
        for (const [p, f] of fields) {
          const raw = f.value;
          if (raw === "" && p.default === undefined) { message.textContent = "Enter " + p.name + "."; return false; }
          values[p.name] = p.type === "number" || p.type === "integer" ? Number(raw) : p.type === "boolean" ? raw === "true" :
            p.type === "string" ? raw : (() => { try { return JSON.parse(raw); } catch { return raw; } })();
        }
      }}]});
    return await d.done === "Preview" ? values : null;
  }
  function stepItems(m, steps) {
    return m.steps.map((s, i) => {
      const r = steps?.find(x => x.index === i);
      const state = !r ? "pending" : r.status === "ready" ? "done" : r.status === "skipped" ? "skipped" : r.status === "failed" ? "failed" : "pending";
      const result = !r ? "" : r.status === "skipped" ? "Skipped: condition not met" : r.status === "failed" ? r.message ?? "Failed" :
        r.changes ? r.changes + (r.changes === 1 ? " change" : " changes") : "No changes";
      return {title:commandTitle(s.command), state, result};
    });
  }
  async function run(m, {stepwise = false} = {}) {
    const values = await parameters(m);
    if (!values) return;
    if (stepwise) return runStepwise(m, values);
    const h = host(), project = h.project(), revision = h.revision();
    outcome = K.statusLine("Planning " + m.name + "…", {busy:true}); render();
    let receipt;
    try { receipt = await B.run(P + "run", {id:m.id, parameters:values}, {mode:"proposal"}); }
    catch (error) { outcome = K.notice({tone:"danger", title:"Not run.", text:error.message}); render(); return; }
    const r = receipt.result, failed = r.status === "failed";
    outcome = null; render();
    const proposal = receipt.proposal;
    const review = await U.review({title:"Run " + m.name,
      source:"Macro " + m.alias + " · " + h.doc().name + " · revision " + revision,
      steps:K.steps(stepItems(m, r.steps)),
      rows:() => { if (failed) throw Object.assign(Error("Stopped at step " + (r.stoppedAt + 1) + ". Nothing would change."), {code:"failed"});
        return proposal ? G.AtriumProposal.inspect(proposal, project) : []; },
      note:r.selected ? "Ends with " + r.selection.length + " objects selected." : undefined,
      applyLabel:proposal ? undefined : r.selected ? "Select" : "Done",
      apply:async () => {
        if (h.revision() !== revision) throw Object.assign(Error("The design changed after this preview. Run the macro again."), {code:"stale_source"});
        const count = proposal ? U.applyOps(project, proposal, m.name) : 1;
        if (r.selected && count) { if (r.documentId !== h.currentId()) await h.selectDocument(r.documentId); h.select(r.selection); }
        return count;
      }});
    const slot = K.el("div");
    if (review.status === "applied" && proposal) { U.receipt(slot, {count:proposal.ops.length, revision:h.revision()}); outcome = slot; }
    else if (failed) outcome = K.notice({tone:"danger", title:"Stopped at step " + (r.stoppedAt + 1) + ".", text:(r.steps.at(-1)?.message ?? "") + " Nothing changed."});
    render();
  }
  async function runStepwise(m, values) {
    const h = host();
    let index = 0;
    const result = await G.AtriumMacros.runStepwise({id:m.id, parameters:values}, {approve:async preview => {
      const step = preview.result.steps[0];
      index = step.index;
      const items = stepItems(m, [step]).map((s, i) => i < index ? {...s, state:"done", result:"Applied"} : s);
      const o = await U.review({title:"Step " + (index + 1) + " of " + m.steps.length, source:"Macro " + m.alias + " · " + commandTitle(step.command),
        steps:K.steps(items), rows:() => G.AtriumProposal.inspect(preview.proposal, h.project()), applyLabel:"Apply step", apply:async () => 1});
      return o.status === "applied";
    }});
    const label = {completed:"Completed.", cancelled:"Stopped at step " + (index + 1) + ".", failed:"Failed at step " + ((result.stoppedAt ?? index) + 1) + "."}[result.status];
    const text = result.applied ? result.applied + (result.applied === 1 ? " step stays applied" : " steps stay applied") +
      (result.status === "completed" ? "." : ". Edit › Undo reverts them one at a time.") : "Nothing changed.";
    outcome = K.notice({tone:result.status === "completed" ? "success" : result.status === "failed" ? "danger" : "warning", title:label,
      text:(result.error?.message ? result.error.message + " " : "") + text});
    if (result.selected) h.select(result.selection);
    render();
  }

  // ------------------------------------------------------------------ export
  async function exportMacro(m) {
    const plan = (await B.run(P + "export", {id:m.id}, {mode:"plan"})).result;
    const perms = K.el("span", "intel-row-badges");
    const words = {"read:project":"Read the project", "ui:command":"Add a command", "propose:edits":"Propose edits for review"};
    perms.append(...plan.permissions.map(p => K.badge(words[p] ?? p)));
    const message = K.el("div");
    const d = G.AtriumShell.dialog({title:"Export macro", body:[K.propRow("Package", plan.name), K.propRow("Command", m.name),
      K.propRow("Permissions", perms, {stacked:true}),
      K.el("p", "ui-section-note", "Installing it asks for these permissions. Each run goes through Review before it changes a design."), message],
    actions:[{label:"Cancel"}, {label:"Export…", primary:true, run:async () => {
      try {
        const receipt = await apply("export", {id:m.id});
        if (receipt.saved === false) { message.replaceChildren(K.notice({text:"Not saved."})); return false; }
      } catch (error) { message.replaceChildren(K.notice({tone:"danger", text:error.message})); return false; }
    }}]});
    if (await d.done === "Export…") { outcome = K.notice({tone:"success", text:"Exported " + plan.name + ". Install it from Extensions in any workspace."}); render(); }
  }

  // ------------------------------------------------------------------ panel
  async function render() {
    if (!panel?.open) return;
    const version = ++render.version;
    const nodes = editing ? renderEditor() : await renderCatalogue();
    if (version !== render.version) return;
    panel.body.replaceChildren(...nodes);
  }
  render.version = 0;
  function build() {
    panel = U.dockPanel({id:"macros", title:"Macros"});
    const spec = {id:"macros", title:"Macros", element:panel.el, area:"right"};
    if (G.AtriumDock?.register) G.AtriumDock.register(spec); else (G.AtriumDockPending ||= []).push(spec);
    recordButton = K.button(recording.status === "recording" ? "Stop" : "Record", {variant:"quiet", size:"sm", run:toggleRecording, pressed:recording.status === "recording"});
    panel.actions.append(recordButton);
    host().on?.("replace", () => { editing = null; outcome = K.statusLine("Showing the macros of this workspace."); workspaceName = host().project().name; render(); });
  }
  async function open() {
    if (!panel) build();
    workspaceName = host().project().name;
    panel.show();
    await G.AtriumLazy.need("AtriumProposal");
    await read("record-status").then(recordingChanged);
    await render();
    return panel;
  }
  function sync(on) { if (!on) { panel?.dispose(); panel = null; editing = null; } }
  return Object.freeze({open, sync, toggleRecording, stopRecording, recordingChanged, run, edit, render,
    get editing() { return editing; }});
})();
