"use strict";

// The provider gets only explicitly projected data. Its output is always data,
// never a permission, an executable command or an approved proposal.
globalThis.AtriumAIProviders = (() => {
  const G = globalThis;
  const own = (object, key) => Object.hasOwn(object, key);
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
  const MAX_PROMPT = 2000, MAX_ANSWER = 4000, MAX_TOOL_CALLS = 8, MAX_ROUNDS = 4, MAX_ROWS = 16, MAX_ACTIVITY = 40;
  const queryFields = Object.freeze(["id","kind","layer","ref","value","width","name"]);
  const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
  const text = (value, max = 160) => typeof value === "string" ? value.slice(0, max) : "";
  const bounded = list => Array.isArray(list) ? list.slice(0, MAX_ROWS) : [];
  const scalar = value => typeof value === "string" ? text(redact(value)) :
    typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const pick = (value, fields) => Object.fromEntries(fields.flatMap(key => {
    const item = scalar(value?.[key]);
    return item === undefined ? [] : [[key, item]];
  }));
  const tools = Object.freeze({
    query: {args:["scope"], required:["scope"], fields:["documentId","instanceId","id","ownerId","kind","pin","padIndex"]},
    inspect_component: {args:["component_id"], required:["component_id"], fields:["id","document_id","kind","ref","value","x","y","angle"]},
    run_erc: {args:[], required:[], fields:["id","document_id","object_id","class","rule","severity"]},
    run_drc: {args:[], required:[], fields:["id","document_id","object_id","rule","severity","actual","required"]},
    evaluate_calculation: {args:["calculation_id"], required:["calculation_id"], fields:["id","document_id","status","value","unit"]},
    compare_revisions: {args:["before","after"], required:["before","after"], fields:["id","kind","added","removed","changed","identical"]},
    list_library: {args:["query"], required:["query"], fields:["id","kind","name","footprint","pins","pads"]},
    project_history: {args:[], required:[], fields:["id","kind","added","removed","changed","merges"]},
  });

  const resultFields = Object.freeze([...new Set(Object.values(tools).flatMap(tool => tool.fields))]);

  function validateRequest(call, allowed) {
    if (!object(call) || !own(tools, call.tool) || !allowed.includes(call.tool))
      fail("permission_denied", "This AI tool requires a separate read grant.");
    const {args, required} = tools[call.tool], inputs = call.args ?? {};
    if (!object(inputs) || required.some(key => !own(inputs, key)) ||
        Object.keys(inputs).some(key => !args.includes(key) || typeof inputs[key] !== "string" ||
          inputs[key].length === 0 || inputs[key].length > (key === "scope" ? 768 : 128)))
      fail("invalid_arguments", "An AI tool received invalid arguments.");
    return {tool:call.tool, args:Object.fromEntries(args.filter(key => own(inputs,key)).map(key => [key, inputs[key]]))};
  }

  function redact(value) {
    return text(value, MAX_ANSWER)
      .replace(/\b(?:sk-[\w-]{12,}|Bearer\s+[\w.=+\/-]{8,}|(?:api[_ -]?key|secret|password)\s*[:=]\s*\S+)/gi, "[redacted]");
  }

  function projectContext(ctx) {
    const {project, documentId, selection, revision, sourceRevision} = ctx;
    const doc = project.documents.find(item => item.id === documentId);
    return {application:"Waffle EDA", version:ctx.services?.native?.version ?? G.AtriumAbout?.VERSION,
      projectId:project.id, revision:sourceRevision ?? revision,
      active:doc ? {id:doc.id, kind:doc.kind} : null,
      summary:{documentCount:project.documents.length,libraryEntries:project.library?.length ?? 0},
      selection:bounded(selection).filter(identifier)};
  }

  function rowCitation(projectId, tool, row, ticket) {
    const objectId = row.id ?? row.object_id;
    const documentId = row.documentId ?? row.document_id;
    const record = G.AtriumLinkRecord;
    const evidence = {tool, row};
    if (!record?.id(projectId) || !record.id(objectId)) return {ticket,evidence};
    return {ticket,evidence, url:record.format({projectId,objectId}), label:text(row.ref ?? row.name ?? row.kind) || objectId,
      ...(record.id(documentId) ? {documentId} : {})};
  }

  function toolRows(tool, output, decision) {
    const body = Array.isArray(output) ? output : output?.rows;
    const keys = tools[tool].fields.filter(key => decision.fields.includes(key));
    const unscoped = ["list_library","project_history","compare_revisions"].includes(tool);
    const rows = [];
    for (const row of Array.isArray(body) ? body : []) {
      if (!object(row)) continue;
      const owner = row.documentId ?? row.document_id;
      if (owner == null ? !unscoped : !decision.documents.includes(owner)) continue;
      const projected = pick(row,keys);
      if (!Object.keys(projected).length) continue;
      rows.push(projected);
      if (rows.length === MAX_ROWS) break;
    }
    return rows;
  }

  const capture = async (input, context, transport, onRead) => {
    const {decision} = transport, initial = projectContext(context);
    if (!decision || typeof transport.provider !== "function" || !decision.providers.includes(input.provider))
      fail("permission_denied", "The AI provider has no current approval.");
    if (!initial.active || !decision.documents.includes(initial.active.id))
      fail("permission_denied", "The active document needs an AI read grant.");
    const question = text(input.prompt, MAX_PROMPT);
    if (!question.trim()) fail("invalid_arguments", "Enter a question.");
    const grants = Object.keys(tools).filter(name => decision.tools.includes(name));
    const selection = initial.selection.filter(id => decision.objects.includes(id));
    const doc = context.project.documents.find(row => row.id === initial.active.id);
    const keys = ["id","kind","ref","value"].filter(key => decision.fields.includes(key));
    const selected = selection.flatMap(id => {
      const item = doc.items.find(row => row.id === id);
      return item ? [pick(item, keys)] : [];
    });
    const contextData = {...initial, selection, selected,
      ...(decision.findingCounts && {findings:pick(decision.findingCounts,["fatal","error","warning","hint","total"])})};
    const reads = [], citations = new Map();
    let calls = 0;
    function current() {
      if (context.signal?.aborted || context.isCurrent?.() === false || decision.current?.() === false)
        fail("stale_source", "The project or AI permission changed. Start a fresh request.");
    }
    for (let turn = 0; turn <= MAX_ROUNDS; turn++) {
      current();
      const reply = await transport.provider(input.provider, {
        question, context:contextData, tools:grants.map(tool => ({tool,args:tools[tool].args})), reads:[...reads]
      });
      current();
      if (object(reply) && reply.type === "answer" && typeof reply.text === "string") {
        const claimed = new Set(Array.isArray(reply.citations) ? reply.citations : []);
        const cited = [...claimed].filter(ticket => citations.has(ticket));
        const picked = cited.slice(0, MAX_ROWS).map(ticket => citations.get(ticket));
        const output = {status:"answered", text:redact(reply.text), citations:picked, tools:calls,
          ...(cited.length > picked.length && {citationsOmitted:cited.length - picked.length})};
        if (reply.suggestion !== undefined && decision.mayPropose?.(input.provider) === true) {
          const {ops} = draft(reply.suggestion,{...context,selection});
          if (ops.length) {
            output.proposal = G.AtriumButter.proposal(context.project,"butter.ai.draft",ops);
            output.proposalRevision = initial.revision;
          }
        }
        return output;
      }
      if (!object(reply) || reply.type !== "tools" || !Array.isArray(reply.calls) ||
          !reply.calls.length || reply.calls.length + calls > MAX_TOOL_CALLS || turn === MAX_ROUNDS)
        fail("invalid_provider_result", "The provider did not return a bounded answer.");
      for (const raw of reply.calls) {
        const request = validateRequest(raw, grants);
        if (request.tool === "inspect_component" && !decision.objects.includes(request.args.component_id))
          fail("permission_denied", "The selected AI grant does not include that component.");
        if (request.tool === "evaluate_calculation" && !decision.objects.includes(request.args.calculation_id))
          fail("permission_denied", "The selected AI grant does not include that calculation.");
        current();
        const output = await transport.tool(request.tool, request.args, {
          projectId:initial.projectId, documentId:initial.active.id, revision:initial.revision,
          documents:[...decision.documents], fields:[...decision.fields], limit:MAX_ROWS
        });
        current();
        const rows = toolRows(request.tool, output, decision);
        const result = {tool:request.tool,
          ...(Number.isSafeInteger(output?.total) && {total:output.total, truncated:output.total > rows.length}),
          ...(output?.partial === true && {partial:true}),
          rows:rows.map((row,index) => {
            const ticket = "t" + (calls + 1) + "." + (index + 1);
            citations.set(ticket, rowCitation(initial.projectId,request.tool,row,ticket));
            return {...row, citation:ticket};
          })};
        reads.push(result);
        calls++;
        onRead?.({tool:request.tool, rows:rows.length, fields:tools[request.tool].fields.filter(key => decision.fields.includes(key))});
      }
    }
    fail("invalid_provider_result", "The provider did not return an answer.");
  };

  function state(context, name, value) {
    if (context.source === "editor") return G.AtriumAIProvidersDesktop.local(context.project.id, name, value);
    if (value === undefined) return context.services.state.get(name);
    context.services.state.set(name,value);
  }
  function history(context) {
    const stored = state(context,"activity");
    return Array.isArray(stored) ? stored.slice(-MAX_ACTIVITY) : [];
  }
  const defaultPolicy = Object.freeze({allowed:false, tools:[], proposeEdits:false});
  function policy(context) {
    const saved = state(context,"policy");
    return saved?.allowed === true && Array.isArray(saved.tools) ? {allowed:true,
      tools:saved.tools.filter(tool => own(tools,tool)),proposeEdits:saved.proposeEdits === true} : defaultPolicy;
  }
  function setPolicy(args, context) {
    const accepted = (args.tools || []).filter(tool => own(tools, tool));
    if (accepted.length !== (args.tools || []).length) fail("invalid_arguments", "Choose known AI read tools.");
    const next = {allowed:args.allowed, tools:args.allowed ? [...new Set(accepted)] : [],
      proposeEdits:args.allowed && args.proposeEdits === true};
    if (context.mode === "write") state(context,"policy",next);
    return next;
  }
  async function ask(args, context) {
    const {mode,source,services:{native}} = context, p = policy(context);
    if (mode !== "write") return {status:p.allowed ? "plan" : "opted-out", provider:args.provider, tools:p.tools};
    if (!p.allowed) fail("permission_denied", "This project has not opted into AI requests.");
    if (source === "mcp") {
      const granted = context.project.documents.find(doc => doc.id === args.documentId);
      if (!granted) fail("permission_denied", "Choose a document in the selected project.");
      context = {...context, documentId:granted.id, selection:args.selection ?? []};
      if (native?.stage === "consent") {
        if (!G.AtriumAIProvidersMCP?.providers(native).some(provider => provider.id === args.provider))
          fail("permission_denied", "This AI provider is unavailable to the selected workspace.");
        const tool = args.read ? validateRequest(args.read,p.tools) : null;
        if (tool?.tool === "inspect_component" && !context.selection.includes(tool.args.component_id) ||
            tool?.tool === "evaluate_calculation" && !context.selection.includes(tool.args.calculation_id))
          fail("permission_denied", "Read access is limited to selected objects.");
        return {status:"consent", tool, revision:context.sourceRevision};
      }
    } else if (args.read || args.selection || args.documentId && args.documentId !== context.documentId) {
      fail("permission_denied", "Desktop AI requests use the editor's current selection.");
    }
    const record = {provider:args.provider, at:Date.now(), promptCharacters:args.prompt.length,
      promptExcerpt:redact(args.prompt).slice(0,256), readTools:[], result:"failed"};
    let transport;
    try {
      transport = source === "mcp" ? G.AtriumAIProvidersMCP?.transport(native,context,p) :
        G.AtriumAIProvidersDesktop?.transport(context,p,args.provider);
      if (!transport) fail("unsupported_command", "This AI provider is unavailable on this surface.");
      await transport.prepare?.();
      const value = await capture(args, context, transport, item => record.readTools.push(item));
      record.result = value.status;
      record.answerCharacters = value.text.length;
      record.answerExcerpt = value.text.slice(0,256);
      record.citations = value.citations.length;
      record.proposed = value.proposal?.ops?.length ?? 0;
      state(context,"activity",[...history(context),record].slice(-MAX_ACTIVITY));
      return value;
    } catch (error) {
      // Returning a bounded failure allows the shared state transaction to
      // commit the audit entry without persisting untrusted exception text.
      record.result = ["permission_denied","stale_source","cancelled","credential_missing","credential_unavailable","unsupported_command","invalid_provider_result","invalid_arguments"]
        .includes(error.code) ? error.code : "provider_failed";
      state(context,"activity",[...history(context),record].slice(-MAX_ACTIVITY));
      if (context.isCurrent?.() === false) throw error;
      return {status:"failed", code:record.result};
    } finally {
      transport?.close?.();
    }
  }

  function draft(args, context) {
    if (!object(args)) fail("invalid_arguments", "The proposed edit must be a single component field.");
    const {componentId, documentId:requested, field, value} = args;
    const {project,source,selection} = context;
    const documentId = source === "mcp" ? requested : context.documentId;
    if (source !== "mcp" && !selection?.includes(componentId))
      fail("permission_denied", "A proposal needs a selected component in this project.");
    const doc = project.documents.find(row => row.id === documentId);
    const part = doc?.items.find(row => row.id === componentId && row.kind === "part");
    if (!part) fail("not_found", "The selected component is no longer present.");
    if (!["x","y","angle","ref","value"].includes(field) ||
        (["x","y","angle"].includes(field) ? !Number.isFinite(value) : typeof value !== "string" || value.length > 160))
      fail("invalid_arguments", "The proposed value has the wrong type.");
    const result = {componentId,field}, ops = [];
    if (part[field] === value) return {result,ops};
    const set = (item, name, after) => ({op:"set", target:"item", document:doc.id, id:item.id,
      path:[name], ...(item[name] !== undefined ? {before:item[name]} : {}), after});
    ops.push(set(part,field,value));
    if (doc.kind === "schematic" && ["x","y","angle"].includes(field)) {
      const model = G.Atrium, definition = project.library.find(entry => entry.id === part.def);
      const pins = new Set(model.pins(part,definition,doc.kind).map(pin => model.pointKey(pin.at)));
      const originals = new Map(doc.items.filter(item => item.kind === "wire" &&
        [item.points[0],item.points.at(-1)].some(point => pins.has(model.pointKey(point))))
        .map(item => [item.id,item]));
      // A turn carries a power port or label sitting alone on a pin (Atrium.pinTags).
      const defs = new Map(project.library.map(d => [d.id,d]));
      if (field === "angle") for (const tag of model.pinTags(doc,defs,part)) originals.set(tag.id,tag);
      const moved = model.transformPart(doc,{...part},definition,{[field]:value},
        [...originals.values()].map(item => ({...item})),{defs});
      for (const item of moved.slice(1)) {
        const original = originals.get(item.id);
        if (item.kind === "wire") ops.push(set(original,"points",item.points));
        else ops.push(set(original,"x",item.x),set(original,"y",item.y));
      }
    }
    return {result,ops};
  }

  G.AtriumButter.register("ai", {
    providers: (_,context) => ({providers:context.source === "mcp" ?
      G.AtriumAIProvidersMCP?.providers(context.services.native) ?? [] : G.AtriumAIProvidersDesktop?.providers() ?? []}),
    policy: (_,context) => policy(context),
    "set-policy": setPolicy,
    ask,
    draft,
    activity: (_,context) => ({requests:history(context)}),
    "clear-activity": (_,context) => {
      if (context.mode === "write") state(context,"activity",[]);
      return {status:context.mode === "write" ? "cleared" : "plan"};
    },
    credential: ({provider,operation},context) => context.source === "editor" && context.mode === "write" ?
      G.AtriumAIProvidersDesktop.credential(provider,operation) : {available:false}
  });
  return Object.freeze({capture,tools,resultFields,queryFields,redact});
})();
