"use strict";

// Macros hold validated command data and compose guarded edits on a private
// projection. They never replay pointers or acquire authority from a step.
globalThis.AtriumMacros = (() => {
  const G = globalThis, B = G.AtriumButter;
  const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
  const NAME = /^[a-z][a-z0-9-]{0,47}$/;
  const COMMAND = /^(?:butter\.[a-z][A-Za-z0-9]*\.|waffle\.)[a-z][a-z0-9-]*$/;
  const LIMIT = 64, RECORD_BYTES = 128 * 1024;
  const types = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
  const forbidden = new Set(["__proto__", "constructor", "prototype"]);
  const controls = new Set(["list", "save", "remove", "record-start", "record-status", "record-stop", "run", "run-step", "export"]);
  const sessions = new WeakMap();
  const own = Object.hasOwn;
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const clone = value => JSON.parse(JSON.stringify(value));
  const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
  const invalid = message => fail("invalid_arguments", message);
  const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
  const bounded = (value, limit) => typeof value === "string" && value.trim().length > 0 && value.length <= limit;
  const control = id => id.startsWith("butter.macros.") && controls.has(id.slice(14));
  const defaultKey = /^(?:(?:(?:Ctrl|Alt|Cmd|Mod|Shift)\+)+(?:[A-Z0-9]|F(?:[1-9]|1\d|2[0-4]))|F(?:[1-9]|1[0-2]))$/;
  const reservedKey = /^(?:(?:Ctrl|Cmd|Mod)\+)+[SOZYXCVADMWGL]$/;

  function fields(value, names, label) {
    if (!object(value) || Object.keys(value).some(key => !names.includes(key))) invalid("Invalid " + label + ".");
  }

  function argument(value, parameterNames, depth = 0) {
    if (depth > 12) invalid("A macro argument is nested too deeply.");
    if (typeof value === "number" && !Number.isFinite(value)) invalid("Macro numbers must be finite.");
    if (Array.isArray(value)) {
      if (value.length > 5000) invalid("A macro argument has too many entries.");
      return value.map(item => argument(item, parameterNames, depth + 1));
    }
    if (!object(value)) return value;
    if (own(value, "$parameter")) {
      fields(value, ["$parameter"], "parameter reference");
      if (!parameterNames.has(value.$parameter)) invalid("A step uses an undeclared macro parameter.");
      return {$parameter:value.$parameter};
    }
    if (own(value, "$context")) {
      fields(value, ["$context"], "context reference");
      if (!["selection", "documentId"].includes(value.$context)) invalid("A step uses an unknown context value.");
      return {$context:value.$context};
    }
    if (Object.keys(value).some(key => forbidden.has(key))) invalid("A step contains an invalid argument field.");
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, argument(child, parameterNames, depth + 1)]));
  }

  function typed(value, type) {
    if (type === "array") return Array.isArray(value);
    if (type === "null") return value === null;
    if (type === "object") return object(value);
    if (type === "integer") return Number.isSafeInteger(value);
    return typeof value === type && (type !== "number" || Number.isFinite(value));
  }

  function record(input, newIdentity = false) {
    fields(input, ["format", "version", "id", "name", "alias", "shortcut", "selectionOnly", "parameters", "steps"], "macro record");
    if (input.format !== "waffle-macro" || input.version !== 1) invalid("Expected a version 1 Waffle macro.");
    if ((input.id !== undefined || !newIdentity) && !matches(ID, input.id)) invalid("The macro needs a durable identifier.");
    if (!bounded(input.name, 120) || !matches(NAME, input.alias)) invalid("Provide a macro name and a lowercase command alias.");
    if (input.shortcut !== undefined && (!matches(defaultKey, input.shortcut) || /^Shift\+(?!.*\+)/.test(input.shortcut)))
      invalid("Choose a function key or a shortcut with Ctrl, Alt, Cmd or Mod.");
    if (input.shortcut !== undefined && reservedKey.test(input.shortcut)) invalid("That shortcut is reserved by the editor.");
    if (input.selectionOnly !== undefined && typeof input.selectionOnly !== "boolean") invalid("Invalid selection scope.");
    const parameters = input.parameters ?? [], seen = new Set();
    if (!Array.isArray(parameters) || parameters.length > 32) invalid("A macro may have at most 32 parameters.");
    const param = parameters.map(p => {
      fields(p, ["name", "type", "default"], "macro parameter");
      if (!matches(NAME, p.name) || !types.has(p.type) || seen.has(p.name)) invalid("Macro parameters need distinct names and supported types.");
      seen.add(p.name);
      if (own(p, "default") && !typed(p.default, p.type)) invalid("A macro parameter default has the wrong type.");
      return {...p};
    });
    if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > LIMIT)
      invalid("A macro needs between 1 and " + LIMIT + " steps.");
    const stepIds = new Set();
    const steps = input.steps.map(step => {
      fields(step, ["id", "command", "args", "when", "select"], "macro step");
      if (!matches(COMMAND, step.command) || control(step.command)) invalid("A macro step needs a replayable command.");
      if (step.id !== undefined && (!matches(ID, step.id) || stepIds.has(step.id)) || !newIdentity && step.id === undefined)
        invalid("Each step needs a distinct durable identifier.");
      if (!object(step.args ?? {})) invalid("Macro step arguments must be a record.");
      const id = step.id ?? G.Atrium.id();
      stepIds.add(id);
      const out = {id, command:step.command, args:argument(step.args ?? {}, seen)};
      if (step.select !== undefined) {
        if (step.select !== true || step.command !== "butter.query.search") invalid("Only a design query can select its result rows.");
        out.select = true;
      }
      if (step.when !== undefined) {
        fields(step.when, ["source", "savedQueryId", "match"], "macro step condition");
        const {source, savedQueryId, match} = step.when;
        if ((source === undefined) === (savedQueryId === undefined) || match !== undefined && typeof match !== "boolean")
          invalid("A step condition needs one design query and an optional match state.");
        out.when = {...argument(step.when, seen), match:match ?? true};
      }
      return out;
    });
    const macro = {...input, parameters:param, steps, selectionOnly:input.selectionOnly === true};
    if (new TextEncoder().encode(JSON.stringify(macro)).length > RECORD_BYTES) invalid("The macro record is too large.");
    return {...macro, id:input.id ?? G.Atrium.id()};
  }

  function values(macro, input = {}) {
    const parameters = new Map(macro.parameters.map(p => [p.name, p]));
    for (const name of Object.keys(input)) if (!parameters.has(name)) invalid("Unknown macro parameter " + name + ".");
    const result = new Map();
    for (const p of parameters.values()) {
      const value = own(input, p.name) ? input[p.name] : p.default;
      if (value === undefined) fail("missing_parameter", "Provide macro parameter " + p.name + ".");
      if (!typed(value, p.type)) invalid("Macro parameter " + p.name + " has the wrong type.");
      result.set(p.name, clone(value));
    }
    return result;
  }

  function resolve(value, parameters, scope) {
    if (Array.isArray(value)) return value.map(item => resolve(item, parameters, scope));
    if (!object(value)) return value;
    if (own(value, "$parameter")) return parameters.get(value.$parameter);
    if (own(value, "$context")) return scope[value.$context];
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child, parameters, scope)]));
  }

  const definitions = c => c.services.state.get("definitions") || [];
  function lookup(input, c) {
    if ((input.macro === undefined) === (input.id === undefined)) invalid("Choose a saved macro or supply a portable macro record.");
    if (input.macro !== undefined) return record(input.macro);
    const found = definitions(c).find(row => row.id === input.id || row.alias === input.id);
    if (!found) fail("missing_macro", "The macro is unavailable in this workspace.");
    return found;
  }

  function* changedItems(original, draft, positions) {
    for (const [index, d] of draft.documents.entries()) {
      const touched = positions.get(d.id);
      if (!touched) continue;
      const items = original.documents[index].items;
      for (const at of [...touched].sort((a,b) => a-b)) yield [items[at], {d, item:d.items[at]}];
    }
  }

  async function execute(input, c, one = false) {
    const macro = lookup(input, c), parameters = values(macro, input.parameters);
    const {project, services, signal} = c, P = G.AtriumProposal;
    if (!services.commands?.plan) fail("unsupported_surface", "This workspace cannot replay commands.");
    const selection = input.selection ?? c.selection;
    const documentId = input.documentId ?? c.documentId;
    const start = one ? input.index : 0, end = one ? start + 1 : macro.steps.length;
    if (start === 0 && macro.selectionOnly && !selection.length) fail("selection_required", "This macro needs a selection.");
    if (documentId != null && !project.documents.some(doc => doc.id === documentId)) invalid("Choose a document in this workspace.");
    let scope = {project, documentId, selection:[...selection]};
    const outcomes = [];
    let selected = false, edits = 0, soleOps;
    let positions = end - start > 1 ? new Map() : null;
    if (start >= macro.steps.length) invalid("The selected macro step does not exist.");
    for (let index = start; index < end; index++) {
      const step = macro.steps[index], summary = {index, id:step.id, command:step.command};
      try {
        if (signal?.aborted || c.isCurrent?.() === false) fail("stale_source", "The design changed while planning the macro.");
        if (step.when) {
          const {match, ...query} = resolve(step.when, parameters, scope);
          const scopedQuery = query.savedQueryId != null || scope.documentId == null ? query : {...query, documentId:scope.documentId};
          const {result} = await services.commands.plan("butter.query.count", scopedQuery, scope);
          if (result?.status !== "complete" || result.complete !== true)
            fail(result?.diagnostic?.code ?? "query_failed", result?.diagnostic?.message ?? "The condition did not finish.");
          if ((result.count > 0) !== match) { outcomes.push({...summary, status:"skipped"}); continue; }
        }
        const args = resolve(step.args, parameters, scope);
        const {result, ops} = await services.commands.plan(step.command, args, scope);
        if (step.select) {
          if (result?.status !== "complete" || result.complete !== true || result.count !== result.rows?.length)
            fail("selection_limit", "Narrow the query before selecting a partial result.");
          const rows = result.rows;
          const savedScope = args.savedQueryId && scope.project.savedQueries?.find(row => row.id === args.savedQueryId)?.scope;
          const selectedDoc = rows[0]?.documentId ?? args.documentId ?? savedScope?.documentId ?? scope.documentId;
          const known = new Set(scope.project.documents.find(doc => doc.id === selectedDoc)?.items.map(item => item.id));
          if (rows.some(row => row.documentId !== selectedDoc || !known.has(row.id)))
            fail("invalid_selection", "Select query results belonging to one editable document.");
          scope = {...scope, documentId:selectedDoc, selection:[...new Set(rows.map(row => row.id))]};
          selected = true;
        }
        if (ops?.length) {
          const plan = P.guarded(scope.project, step.command, ops);
          const prepared = P.prepare(scope.project, plan, G.Atrium.validate);
          scope = {...scope, project:prepared.project};
          // Independent item sets preserve document membership and item order.
          // Reuse checked positions from staging until a step changes that scope.
          if (positions && prepared.itemPositions && ops.every(op => op.target === "item")) {
            for (const {document, id} of ops) {
              if (!positions.has(document)) positions.set(document, new Set());
              positions.get(document).add(prepared.itemPositions.get(id));
            }
          } else positions = null;
          edits++;
          soleOps = ops;
        }
        outcomes.push({...summary, status:"ready", changes:ops?.length ?? 0, ...(one ? {result} : {})});
      } catch (error) {
        return {ops:[], result:{macro:macro.id, status:"failed", stoppedAt:index, applied:0,
          steps:[...outcomes, {...summary, status:"failed", code:error.code ?? "command_failed", message:String(error.message)}]}};
      }
    }
    let ops = soleOps ?? [];
    if (edits > 1) ops = positions ? P.diffItemPairs(changedItems(project, scope.project, positions)) : P.diff(project, scope.project);
    return {ops, result:{macro:macro.id, status:"ready", changes:ops.length, steps:outcomes,
      selected, selection:scope.selection, documentId:scope.documentId, next:end < macro.steps.length ? end : null}};
  }

  function exportPackage(input, c) {
    const macro = lookup(input, c), id = "waffle-macro." + macro.alias + "." + macro.id.slice(-8);
    const command = id + ".run", name = macro.alias + ".waffle-extension";
    const manifest = {id, name:macro.name, version:"1.0.0", apiVersion:1, main:"main.js",
      activationEvents:["onCommand:" + command], permissions:["read:project", "ui:command", "propose:edits"],
      contributes:{commands:[{command, title:macro.name, ...(macro.selectionOnly ? {when:"selection"} : {})}]}};
    if (macro.shortcut) manifest.contributes.keybindings = [{command, key:macro.shortcut}];
    const script = `"use strict";\nconst macro = JSON.parse(${JSON.stringify(JSON.stringify(macro))});\n` +
      `exports.activate = api => api.commands.register(${JSON.stringify(command)}, async (parameters = {}) => {\n` +
      `  const receipt = await api.commands.execute("butter.macros.run", {macro, parameters});\n` +
      `  if (receipt.result.status === "failed" || !receipt.proposal) return receipt;\n` +
      `  return api.proposals.submit(receipt.proposal, macro.name);\n});\n`;
    return {result:{name, command, permissions:manifest.permissions}, file:{name, data:JSON.stringify({manifest, files:{"main.js":script}})}};
  }

  const session = c => c.services.workspace && sessions.get(c.services.workspace);
  function capture(event) {
    const recording = event.workspace && sessions.get(event.workspace);
    if (!recording || recording.full || recording.steps.length >= LIMIT || !COMMAND.test(event.id) || control(event.id)) return;
    const args = argument(event.args ?? {}, new Set());
    const step = {id:G.Atrium.id(), command:event.id, args, ...(event.select === true ? {select:true} : {})};
    const length = new TextEncoder().encode(JSON.stringify(step)).length;
    if (recording.bytes + length > RECORD_BYTES / 2) {recording.full = true; return;}
    recording.steps.push(step);
    recording.bytes += length;
  }

  function documentFor(a, c, kind) {
    const id = a.documentId ?? c.documentId;
    const docs = c.project.documents, doc = id == null ? docs.find(doc => doc.kind === kind) : docs.find(doc => doc.id === id);
    if (doc?.kind !== kind) fail("wrong_document", "Choose a " + (kind === "pcb" ? "PCB" : kind) + " document.");
    return doc;
  }

  function setTrackWidth(a, c) {
    const doc = documentFor(a, c, "pcb"), ids = new Set(a.ids ?? c.selection);
    if (!ids.size) fail("selection_required", "Select the tracks whose width will change.");
    const tracks = doc.items.filter(i => ids.has(i.id));
    if (tracks.length !== ids.size || tracks.some(i => i.kind !== "track" || i.locked))
      fail("invalid_selection", "Choose existing unlocked tracks in the selected PCB.");
    const ops = tracks.filter(i => i.width !== a.width).map(i => ({op:"set", target:"item", document:doc.id,
      id:i.id, path:["width"], before:i.width, after:a.width}));
    return {result:{documentId:doc.id, width:a.width, changed:ops.length}, ops};
  }

  async function runDRC(a, c) {
    const current = c.project.documents.find(doc => doc.id === c.documentId && doc.kind === "pcb");
    const doc = documentFor(a, {...c, documentId:current?.id}, "pcb"), R = G.AtriumRules, D = G.AtriumDRC;
    const defs = new Map(c.project.library.map(def => [def.id, def]));
    if (a.rules?.some(type => !own(R.types, type))) invalid("Choose known PCB rule types.");
    const rules = R.stored(doc, c.project) || R.defaults();
    const pending = D.prepare(rules);
    if (pending) {
      await pending;
      if (c.isCurrent?.() === false) fail("stale_source", "The design changed while preparing the rule check.");
    }
    let result = D.batch(doc, defs, rules, {project:c.project, types:a.rules});
    if (doc.drcWaivers?.length) result = G.AtriumDRCWaivers.apply(doc, result).result;
    return {documentId:doc.id, total:result.total, rules:result.rules.map(rule => ({id:rule.id, count:rule.count})),
      notes:result.notes, complete:result.complete, diagnostics:result.diagnostics};
  }

  function placePowerPort(a, c) {
    const doc = documentFor(a, c, "schematic"), ids = a.ids ?? c.selection;
    const part = ids.length === 1 && doc.items.find(item => item.id === ids[0] && item.kind === "part");
    if (!part) fail("invalid_selection", "Select one schematic component for the power port.");
    const sheet = {...doc, items:[...doc.items]};
    const draft = {...c.project, documents:[sheet]};
    const result = G.AtriumSchAuthor.addPowerPort(draft, {sheet:doc.id, net:a.net ?? "GND",
      at:{designator:part.id, pin:a.pin}, style:a.style, direction:a.direction});
    const value = sheet.items.at(-1);
    if (a.showName !== undefined) value.showName = a.showName;
    const op = {op:"add", target:"item", document:doc.id, after_id:doc.items.at(-1)?.id ?? null, value};
    return {result, ops:[op]};
  }

  const keys = new Map(), prefix = "butter.macros.";
  const enabled = () => B.state("macros").enabled;
  const workspaceOf = host => host.fileSession?.() ?? host.project();
  let editorChange = 0, keyWorkspace, stopObservation;

  async function editorMacro(input) {
    if (input.macro !== undefined) return record(input.macro);
    const list = await B.run(prefix + "list");
    const macro = list.result.records.find(row => row.id === input.id || row.alias === input.id);
    if (!macro) fail("missing_macro", "The macro is unavailable in this workspace.");
    return macro;
  }

  async function runStepwise(input, {approve} = {}) {
    if (typeof approve !== "function") fail("write_not_allowed", "The editor must approve each planned change.");
    const host = G.AtriumNavHost, project = host.project();
    const macro = await editorMacro(input), steps = [];
    const args = {macro, ...(input.parameters ? {parameters:input.parameters} : {}),
      selection:input.selection ?? host.selection(), documentId:input.documentId ?? host.currentId()};
    let applied = 0, selected = false, revision = host.revision();
    const current = () => enabled() && host.project() === project && host.revision() === revision;
    const stopped = (state, index, error) => ({status:state, macro:macro.id, steps, applied, stoppedAt:index,
      ...(error ? {error:{code:error.code ?? "command_failed", message:error.message}} : {})});
    for (const index of macro.steps.keys()) {
      try {
        if (!current()) fail("stale_source", "The project changed during step-by-step macro replay.");
        const call = {...args, index};
        const preview = await B.run(prefix + "run-step", call, {mode:"proposal"});
        const status = preview.result.steps[0];
        if (preview.result.status === "failed") return stopped("failed", index, status);
        if (preview.proposal) {
          if (await approve(preview) !== true) return stopped("cancelled", index);
          if (!current()) fail("stale_source", "The design changed after previewing this macro step.");
          const prepared = G.AtriumProposal.prepare(project, preview.proposal, G.Atrium.validate);
          const count = prepared.apply((change, touched, scope) => host.edit(change, macro.name, touched, scope));
          if (!count) fail("read_only", "The current project did not accept this macro step.");
          applied++;
        }
        steps.push(status);
        selected ||= preview.result.selected;
        args.selection = preview.result.selection;
        args.documentId = preview.result.documentId;
        revision = host.revision();
      } catch (error) {return stopped("failed", index, error);}
    }
    return {status:"completed", macro:macro.id, steps, applied, selected, selection:args.selection, documentId:args.documentId};
  }

  function clearKeys() {
    for (const {handle} of keys.values()) handle.dispose();
    keys.clear();
  }
  async function syncEditor() {
    const version = ++editorChange, host = G.AtriumNavHost, workspace = host && workspaceOf(host);
    if (!enabled() || workspace !== keyWorkspace) clearKeys();
    keyWorkspace = workspace;
    if (!enabled() || !host) return;
    const {result} = await B.run(prefix + "list");
    if (version !== editorChange || !enabled() || workspace !== workspaceOf(host)) return;
    clearKeys();
    for (const macro of result.records) {
      const id = prefix + "alias." + macro.alias;
      const handle = G.AtriumKeymap.registerCommand({id, title:macro.name, category:"Macros",
        when:macro.selectionOnly ? "selection" : "", defaultKeys:macro.shortcut,
        async run(parameters) {
          if (!enabled() || workspace !== workspaceOf(host)) return;
          try {
            const args = {id:macro.id, ...(object(parameters) ? {parameters} : {})};
            const receipt = await G.AtriumButterEditor.apply(prefix + "run", args);
            const result = receipt.result;
            if (result.status === "failed") {host.info(result.steps.at(-1).message); return;}
            if (result.selected && result.documentId !== host.currentId()) await host.selectDocument(result.documentId);
            if (result.selected && workspace === workspaceOf(host) && result.documentId === host.currentId())
              host.select(result.selection);
            host.info(macro.name + " · " + result.changes + " changes");
          } catch (error) {host.info(error.message);}
        }});
      keys.set(id, {handle, macro});
    }
  }

  function recordCurrent(id, args, result, mode, select = false) {
    const host = G.AtriumNavHost;
    if (!enabled() || !host || !stopObservation) return;
    try {
      const {spec} = B.resolve(id, "macro");
      B.check(spec, args, "macro", mode, mode === "write");
      if (spec.replayable) B.report(workspaceOf(host), spec, args, {command:id, result, mode, select});
    } catch (error) {
      if (error.code !== "butter_disabled") G.console?.warn?.(error);
    }
  }

  function watchEditor() {
    stopObservation?.();
    stopObservation = enabled() ? B.observe(event => {
      if (event.replayable) capture(event);
      if (event.id === prefix + "save" || event.id === prefix + "remove") {
        syncEditor().catch(error => G.AtriumNavHost?.info(error.message));
      }
    }) : undefined;
    syncEditor().catch(error => G.AtriumNavHost?.info(error.message));
  }

  function selectionCommands() {
    if (!enabled()) return [];
    return [...keys].filter(([, {macro}]) => macro.selectionOnly).map(([id, {macro}]) => ({
      id:macro.id, name:macro.name, alias:macro.alias, run:parameters => G.AtriumKeymap.command(id)?.run(parameters),
    }));
  }

  B.register("macros", {
    list: (_, c) => ({records:definitions(c)}),
    save({macro}, c) {
      const row = record(macro, true), base = definitions(c);
      if (base.some(item => item.alias === row.alias && item.id !== row.id)) fail("alias_conflict", "Another macro already uses this alias.");
      const next = [...base.filter(item => item.id !== row.id), row];
      if (next.length > LIMIT || JSON.stringify(next).length > 900 * 1024) fail("resource_limit", "The macro catalogue is full.");
      if (c.mode === "write") c.services.state.set("definitions", next);
      return {macro:row};
    },
    remove({id}, c) {
      const base = definitions(c), next = base.filter(row => row.id !== id);
      if (c.mode === "write" && next.length !== base.length) c.services.state.set("definitions", next);
      return {removed:next.length !== base.length};
    },
    "record-start"(_, c) {
      if (!c.services.workspace) fail("unsupported_surface", "This workspace cannot record commands.");
      if (session(c)) fail("already_recording", "A recording is already in progress.");
      if (c.mode === "write") sessions.set(c.services.workspace, {steps:[], bytes:0, full:false});
      return {status:c.mode === "write" ? "recording" : "ready"};
    },
    "record-status"(_, c) {
      const current = session(c);
      return {status:current ? "recording" : "idle", count:current?.steps.length ?? 0,
        full:current?.full === true || current?.steps.length === LIMIT};
    },
    "record-stop"(_, c) {
      const current = session(c);
      if (!current && c.mode === "plan") return {status:"idle", steps:[], full:false};
      if (!current) fail("not_recording", "No macro recording is in progress.");
      if (c.mode === "write") sessions.delete(c.services.workspace);
      return {status:c.mode === "write" ? "stopped" : "recording", steps:clone(current.steps),
        full:current.full || current.steps.length === LIMIT};
    },
    run: (input, c) => execute(input, c),
    "run-step": (input, c) => execute(input, c, true),
    "set-track-width": setTrackWidth,
    "check-design-rules": runDRC,
    "place-power-port": placePowerPort,
    export:exportPackage,
  });
  if (G.AtriumPrefs && G.AtriumKeymap) {
    G.AtriumPrefs.on("butter.macros", watchEditor);
    G.AtriumNavHost?.on("replace", () => syncEditor().catch(error => G.AtriumNavHost?.info(error.message)));
    watchEditor();
  } else B.observe(event => {if (event.replayable) capture(event);});
  // The saved macro behind a registered command (the Active Bar opens Run… for one with parameters).
  const forCommand = id => keys.get(id)?.macro ?? null;
  return Object.freeze({record, recordCurrent, runStepwise, selectionCommands, forCommand});
})();
