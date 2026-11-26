"use strict";
// One broker for first-party Butter handlers. Desktop and MCP supply separate authority.
globalThis.AtriumButter = (() => {
  const G = globalThis, registered = new Map(), stores = new WeakMap(), views = new WeakMap();
  const workspaceIDs = new WeakMap();
  const observers = new Set();
  const own = (o, k) => Object.hasOwn(o, k);
  const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
  const bad = message => fail("invalid_arguments", message);
  function workspace(scope) {
    if (!workspaceIDs.has(scope)) workspaceIDs.set(scope, Object.freeze(Object.create(null)));
    return workspaceIDs.get(scope);
  }

  function register(feature, handlers) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(feature) || registered.has(feature) || !object(handlers))
      throw Error("Invalid or duplicate Butter feature " + feature + ".");
    registered.set(feature, Object.freeze({...handlers}));
    G["AtriumButterFeature_" + feature] = true;
  }

  // Wrap only records a command reads. Array identity and normal read methods are preserved.
  function readonly(value) {
    if (value === null || typeof value !== "object") return value;
    if (views.has(value)) return views.get(value);
    const reject = () => fail("read_only", "Butter commands receive a read-only project view.");
    const view = new Proxy(Array.isArray(value) ? [] : {}, {
      get(_, key, receiver) {return readonly(Reflect.get(value, key, receiver));},
      has(_, key) {return key in value;},
      ownKeys() {return Reflect.ownKeys(value);},
      getOwnPropertyDescriptor(_, key) {
        const desc = Object.getOwnPropertyDescriptor(value, key);
        if (!desc) return;
        if (Array.isArray(value) && key === "length") return {value:value.length, writable:true, enumerable:false, configurable:false};
        return {value:readonly(Reflect.get(value, key, view)), writable:false, enumerable:desc.enumerable, configurable:true};
      },
      set:reject, deleteProperty:reject, defineProperty:reject, setPrototypeOf:reject, preventExtensions:reject
    });
    views.set(value, view);
    return view;
  }

  function keyOf(value) {
    if (Array.isArray(value)) return "[" + value.map(keyOf).join(",") + "]";
    if (object(value)) return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + keyOf(value[k])).join(",") + "}";
    return JSON.stringify(value);
  }

  function validate(s, value, where = "args") {
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (s.type && ![].concat(s.type).some(k => k === "integer" ? Number.isInteger(value) : k === type && (k !== "number" || Number.isFinite(value))))
      bad(where + " has the wrong type.");
    if (s.enum && !s.enum.some(e => keyOf(e) === keyOf(value))) bad(where + " has an invalid value.");
    if (type === "string") {
      const n = [...value].length;
      if (n < (s.minLength ?? 0) || n > (s.maxLength ?? Infinity) || s.pattern && !new RegExp(s.pattern, "u").test(value))
        bad(where + " does not match the expected format.");
    } else if (type === "number") {
      if (!Number.isFinite(value) || value < (s.minimum ?? -Infinity) || value > (s.maximum ?? Infinity)) bad(where + " is out of range.");
    } else if (type === "array") {
      if (value.length < (s.minItems ?? 0) || value.length > (s.maxItems ?? Infinity) ||
          s.uniqueItems && new Set(value.map(keyOf)).size !== value.length) bad(where + " has invalid entries.");
      for (const [i, item] of value.entries()) validate(s.items ?? {}, item, where + "[" + i + "]");
    } else if (type === "object") {
      const keys = Object.keys(value), props = s.properties ?? {};
      if (keys.length < (s.minProperties ?? 0) || keys.length > (s.maxProperties ?? Infinity))
        bad(where + " has the wrong number of fields.");
      for (const key of s.required ?? []) if (!own(value, key)) bad(where + " requires " + key + ".");
      for (const key of keys) {
        if (["constructor", "prototype", "__proto__"].includes(key)) bad(where + " has an invalid field.");
        if (own(props, key)) validate(props[key], value[key], where + "." + key);
        else if (s.additionalProperties === false) bad(where + " has the unknown field " + key + ".");
        else validate(object(s.additionalProperties) ? s.additionalProperties : {}, value[key], where + "." + key);
      }
    } else if (type !== "null" && type !== "boolean") bad(where + " must contain JSON data.");
  }

  const defaultSurfaces = ["editor", "macro", "mcp"];
  const modesByKind = {read:["read","plan"], edit:["proposal","plan","write"],
    state:["plan","write"], output:["plan","write"]};
  const standaloneContracts = new WeakMap();

  // Standalone descriptors are ordinary objects and may be edited between calls.
  // Reuse the normalized contract until the fields that define it change.
  function standaloneContract(spec) {
    const {kind, properties, required} = spec;
    const surfaces = spec.surfaces ?? defaultSurfaces;
    const macro = !spec.invokesCommands, nested = !spec.mcpAdapter || Boolean(spec.mcpMacro);
    const cached = standaloneContracts.get(spec);
    if (cached && cached.kind === kind && cached.schema.properties === properties && cached.schema.required === required &&
        cached.macro === macro && cached.nested === nested && cached.source === surfaces &&
        (cached.snapshot === surfaces || cached.snapshot.length === surfaces.length &&
          cached.snapshot.every((source, i) => source === surfaces[i]))) return cached;

    const readEdit = kind === "read" || kind === "edit";
    function includes(source) {
      if (source === "extension") return readEdit && surfaces.includes("editor");
      if (source === "macro" || source === "mcp-macro") return readEdit && macro && surfaces.includes("macro") &&
        (source === "macro" || surfaces.includes("mcp") && nested);
      return surfaces.includes(source);
    }
    const array = Array.isArray(surfaces);
    const allowed = array ? [...new Set([...surfaces, "extension", "macro", "mcp-macro"])].filter(includes) : {includes};
    const schema = Object.freeze({type:"object", properties, required, additionalProperties:false, maxProperties:64});
    const contract = {surfaces:allowed, modes:modesByKind[kind], defaultMode:undefined, schema, kind, macro, nested, source:surfaces,
      snapshot:array && surfaces !== defaultSurfaces ? [...surfaces] : surfaces};
    standaloneContracts.set(spec, contract);
    return contract;
  }

  function contractOf(spec) {
    const compiled = spec.contract;
    if (compiled?.modes != null && compiled.schema != null) return compiled;
    const raw = standaloneContract(spec);
    if (!compiled) return raw;
    const {surfaces, defaultMode} = compiled, modes = compiled.modes ?? raw.modes, schema = compiled.schema ?? raw.schema;
    const previous = raw.withOverrides;
    if (previous && previous.surfaces === surfaces && previous.modes === modes &&
        previous.defaultMode === defaultMode && previous.schema === schema) return previous;
    return raw.withOverrides = {surfaces, modes, defaultMode, schema};
  }

  const eligible = (spec, source) => contractOf(spec).surfaces.includes(source);
  const argumentSchema = spec => contractOf(spec).schema;
  function check(spec, args, source, requestedMode, allowWrite) {
    const contract = contractOf(spec);
    if (!contract.surfaces.includes(source)) fail("unsupported_surface", "This Butter command is unavailable on this surface.");
    const {modes, defaultMode, schema} = contract;
    const mode = requestedMode === undefined ? defaultMode ?? modes?.[0] : requestedMode;
    if (!modes?.includes(mode)) fail("unsupported_mode", "This Butter command does not support " + mode + " mode.");
    if (mode === "write" && !allowWrite) fail("write_not_allowed", "An explicit write grant is required.");
    validate(schema, args);
    if (source === "mcp-macro" && spec.mcpMacro &&
        Object.entries(spec.mcpMacro).some(([key, choices]) => !choices.includes(args[key])))
      fail("unsupported_surface", "This Butter command requires a typed host adapter for the requested arguments.");
    return mode;
  }

  function invoke(feature, spec, args, context, finish) {
    const {source, project, selection, documentId, revision, sourceRevision, isCurrent, signal} = context, id = "butter." + feature + "." + spec.id;
    const mode = check(spec, args, context.surface ?? source, context.mode, context.allowWrite);
    const handlers = registered.get(feature), handler = handlers && own(handlers, spec.id) && handlers[spec.id];
    if (typeof handler !== "function") fail("unsupported_command", id + " is unavailable in this build.");

    const scope = context.scope;
    if (!stores.has(scope)) stores.set(scope, new Map());
    const scoped = stores.get(scope);
    if (!scoped.has(feature)) scoped.set(feature, new Map());
    const store = scoped.get(feature), staged = new Map(), stamp = new Map();
    const state = Object.freeze({
      get(key) {
        if (!stamp.has(key)) stamp.set(key, store.get(key));
        return clone((staged.has(key) ? staged : store).get(key));
      },
      set(key, value) {
        if (mode !== "write" || spec.kind !== "state") fail("write_not_allowed", "This call cannot change Butter state.");
        if (typeof key !== "string" || !key || key.length > 128 || value === undefined) bad("Invalid Butter state entry.");
        const json = JSON.stringify(value);
        if (json.length > 1048576 || (!store.has(key) && !staged.has(key) && store.size + staged.size >= 64))
          fail("resource_limit", "Butter state exceeded its storage limit.");
        if (!stamp.has(key)) stamp.set(key, store.get(key));
        staged.set(key, JSON.parse(json));
      }
    });
    let refused;
    const timing = G.AtriumDiagnostics?.performance?.begin("automation", "command");
    function complete(output) {
      if (!object(output ?? {})) fail("invalid_result", "A Butter command must return a result record.");
      output ??= {};
      const result = clone(spec.kind === "edit" || spec.kind === "output" ? output.result ?? {} : output);
      const ops = spec.kind === "edit" ? clone(output.ops) : undefined;
      if (spec.kind === "edit" && (!Array.isArray(ops) || ops.length > 50000))
        fail("invalid_result", "A Butter edit needs a bounded guarded operation list.");
      refused = failure(result);
      timing?.ready();
      return finish({command:id, mode, result}, {ops:refused && ops ? [] : ops, failure:refused,
        file:!refused && mode === "write" && spec.kind === "output" ? output.file : undefined,
        commit() {
          if (staged.size && [...stamp].some(([key,value]) => store.get(key) !== value))
            fail("stale_source", "Butter session state changed during this command.");
          for (const [key, value] of staged) store.set(key, value);
        }});
    }
    const tableFormulas=feature==="tables" ? (documentId,itemId)=>{
      const doc=project.documents.find(doc=>doc.id===documentId);
      const item=doc?.items?.find(item=>item.id===itemId);
      if(G.AtriumTableData?.isItem(item))return G.AtriumTableFormulas.report(project,doc,item,{revision,lazy:true});
    } : undefined;
    const resolveLinkTargets = feature === "links" ? (targets, options) => {
      if (!Array.isArray(targets) || targets.length < 1 || targets.length > 2) bad("Resolve one or two link addresses.");
      const editor = source === "editor" && isCurrent?.() === true ? G.AtriumLinksDesktop : null;
      return (editor ?? G.AtriumLinks).resolveTargets(project, targets, options);
    } : undefined;
    function settle(value) {
      timing.end(signal?.aborted ? "cancelled" : refused ? "failed" : "completed");
      return value;
    }
    function failed(error) {
      timing?.end(signal?.aborted ? "cancelled" : "failed");
      throw error;
    }
    try {
      const output = handler(clone(args), Object.freeze({project:readonly(project), source, mode, documentId, selection:Object.freeze([...(selection ?? [])]),
        revision, sourceRevision, isCurrent, signal, services:Object.freeze({state, workspace:workspace(scope), native:readonly(context.native),
          enabled:context.enabled ?? enabled, tableFormulas, resolveLinkTargets,
          commands:spec.invokesCommands === true && context.plan ? Object.freeze({plan:context.plan}) : undefined})}));
      const result = output?.then ? output.then(complete) : complete(output);
      if (!timing) return result;
      return result?.then ? result.then(settle, failed) : settle(result);
    } catch (error) { return failed(error); }
  }

  function requireSuccess({result}, data) {
    if (data.failure) fail(data.failure.code, data.failure.message);
    return {result, ops:data.ops};
  }

  function failure(result) {
    if (result?.ok !== false && result?.complete !== false && result?.status !== "failed") return null;
    const diagnostic = result.diagnostic ?? result.diagnostics?.[0];
    return {code:diagnostic?.code ?? result.code ?? "command_failed",
      message:diagnostic?.message ?? result.message ?? "The command did not finish."};
  }

  function proposal(p, command, ops) {
    return G.AtriumProposal.guarded(p, command, ops);
  }

  const fileByteLimit = 32 * 1024 ** 2;
  function filePayload(file) {
    if (!object(file) || typeof file.name !== "string" || !file.name || file.name.length > 255 ||
        /^[. ]|[. ]$|[\\/:*?"<>|\u0000-\u001f]/.test(file.name))
      fail("invalid_result", "A Butter output needs a safe file name.");
    const {data} = file;
    if (!file.binary && typeof data === "string" && data.length <= fileByteLimit) return data;
    if (file.binary && (data instanceof Uint8Array || Array.isArray(data) && data.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) &&
        data.length <= fileByteLimit) return data instanceof Uint8Array ? data : Uint8Array.from(data);
    fail("invalid_result", "A Butter output must contain bounded text or bytes.");
  }

  const available = feature => G.AtriumButterCatalog && own(G.AtriumButterCatalog, feature) && G.AtriumButterCatalog[feature];
  const enabled = feature => typeof feature === "string" &&
    (G.AtriumLabs?.butterEnabled?.(feature) ?? G.AtriumPrefs?.get("butter." + feature) === true);
  let desktop;
  function bind(adapter) {desktop = adapter;}
  const state = feature => ({enabled:enabled(feature), available:enabled(feature) && !!available(feature)});
  function resolve(id, source = "editor") {
    const match = typeof id === "string" && /^butter\.([a-z][A-Za-z0-9]*)\.([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(id);
    if (!match) fail("unsupported_command", "Unknown Butter command.");
    const [, feature, local] = match;
    if (!enabled(feature)) fail("butter_disabled", "This Butter feature is disabled.");
    const descriptor = available(feature), spec = descriptor?.commands.find(c => c.id === local);
    if (!spec) fail("unsupported_command", "This Butter command is unavailable.");
    if (!eligible(spec, source)) fail("unsupported_surface", "This Butter command is unavailable on this surface.");
    return {descriptor, spec};
  }
  async function run(id, args = {}, options = {}) {
    const {descriptor, spec} = resolve(id, options.source);
    if (!desktop) fail("unsupported_command", "This Butter command is unavailable.");
    return desktop(descriptor, spec, args, options);
  }
  const list = (source = "editor") => Object.values(G.AtriumButterCatalog ?? {}).filter(f => enabled(f.feature)).flatMap(f =>
    f.commands.filter(c => eligible(c, source)).map(c =>
      ({id:"butter." + f.feature + "." + c.id, title:c.title, kind:c.kind, owner:"waffle"})));
  function observe(listener) {
    observers.add(listener);
    return () => observers.delete(listener);
  }
  function report(scope, spec, args, receipt) {
    if (!observers.size || receipt.mode !== "read" && receipt.mode !== "write" || failure(receipt.result)) return;
    const event = Object.freeze({workspace:workspace(scope), id:receipt.command, args:clone(args), result:clone(receipt.result),
      kind:spec.kind, mode:receipt.mode, replayable:spec.replayable === true, select:receipt.select === true});
    for (const listener of [...observers]) {
      try {listener(event);} catch (error) {G.console?.warn?.(error);}
    }
  }
  return Object.freeze({register, invoke, proposal, requireSuccess, failure, check, argumentSchema, validateArguments:validate, eligible, resolve, filePayload, fileByteLimit, state, list, run, bind, observe, report});
})();
