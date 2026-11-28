"use strict";

// Butter uses Apricot's compiler, projections and committed edit journal. The
// service adds bounded, permission-scoped requests and saved query authoring.
globalThis.AtriumQueryService = (() => {
  const G = globalThis, Q = G.AtriumDesignQuery, I = G.AtriumDesignQueryIndex, R = G.AtriumDesignQueryRecord;
  const contexts = new WeakMap();
  const stamp = a => a?.version ?? a?.revision;
  const now = () => G.performance?.now?.() ?? Date.now();
  const copy = R.copy;
  const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const member = (set, id) => !set || (set.has?.(id) ?? set.includes?.(id));
  const textKey = key => typeof key === "string" && key.length > 0 && key.length <= 512 && !key.includes("\0");
  const readDoc = (a,id) => member(a?.documentIds,id) && (a?.canReadDocument?.(id) ?? true);
  const readField = (a,key) => member(a?.fields ?? a?.allowedFields,key) && (a?.canReadField?.(key) ?? true);
  const denial = () => failure("denied","The requested design scope is unavailable.");
  function failure(code,message,span = [0,0]) {
    const status = ["disabled","denied","cancelled","stale","missing","budget"].includes(code) ? code : "error";
    return {status,complete:false,diagnostic:{code,message,span}};
  }
  function diagnosed(diagnostic) {
    if (diagnostic.code === "denied") return denial();
    return failure(diagnostic.code || "query",diagnostic.message,diagnostic.span);
  }
  function request(options, write = false) {
    const {project,authority,signal} = options;
    const version = stamp(authority);
    const revision = options.revision ?? options.getRevision?.();
    let defs;
    function check() {
      if (!(typeof options.enabled === "function" ? options.enabled() : options.enabled === true))
        return failure("disabled","Enable butter.query to use this query service.");
      if (!project || authority?.revoked || authority?.readProject === false ||
          authority?.projectId && authority.projectId !== project.id || stamp(authority) !== version ||
          write && (authority?.writeProject === false || project.atriumCompat?.readOnly)) return denial();
      if (signal?.aborted) return failure("cancelled","The query was cancelled.");
      if (options.getRevision && options.getRevision() !== revision || options.isCurrent?.(revision) === false)
        return failure("stale","The design snapshot changed.");
      return null;
    }
    return {...options, revision, check, definitions:() => defs ??= new Map((project.library || []).map(d => [d.id,d]))};
  }
  function scoped(input, options) {
    const bad = options.check();
    if (bad) return bad;
    const {project,authority,instanceId,documentId} = options;
    let query = input, where = {documentId,instanceId}, fields = options.fields ?? [];
    if (plain(input) && Object.hasOwn(input,"savedQueryId")) {
      const record = project.savedQueries?.find(row => row.id === input.savedQueryId);
      if (!record || !canReadSaved(record,options)) return options.authority ? denial() : failure("missing","The saved query is unavailable.");
      const saved = record.scope;
      if (saved.documentId != null && documentId != null && saved.documentId !== documentId ||
          saved.instanceId != null && instanceId != null && saved.instanceId !== instanceId)
        return authority ? denial() : failure("scope","The requested scope conflicts with the saved query.");
      where = {documentId:saved.documentId ?? documentId,instanceId:saved.instanceId ?? instanceId};
      query = record.query;
      fields = options.fields ?? record.columns ?? [];
    }
    if (!Array.isArray(fields) || fields.length > 48 || !fields.every(textKey) || new Set(fields).size !== fields.length)
      return failure("fields","Provide at most 48 distinct query field keys.");
    if (!fields.every(key => readField(authority,key))) return denial();
    if (where.instanceId != null && (!textKey(where.instanceId) || !where.documentId)) return failure("instance","Choose a document for this occurrence.");
    if (where.documentId != null && !textKey(where.documentId)) return failure("document","Provide a document ID.");
    const docs = (project.documents || []).filter(doc => where.documentId == null || doc.id === where.documentId);
    if (where.documentId != null && !docs.length || docs.some(doc => !readDoc(authority,doc.id))) return denial();
    const occurrence = where.instanceId == null ? undefined : G.AtriumDesignQueryContext.instance(project,docs[0],where.instanceId);
    if (where.instanceId != null && !occurrence)
      return failure("instance","The requested document occurrence is unavailable.");
    for (let ancestor = occurrence; authority && ancestor?.parent; ancestor = ancestor.parent) {
      const owner = ancestor.parent.doc.id;
      if (!readDoc(authority,owner) || authority.canReadItem?.(ancestor.symbol.id,owner) === false) return denial();
    }
    if (typeof query === "string") query = {languageVersion:R.languageVersion,source:query};
    if (R.isFuture(query)) return failure("language-version","This saved query uses a newer expression language.");
    if (!R.valid(query,{allowUnknown:true})) return failure("record","Invalid native query scope.");
    return {query,docs:docs.sort((a,b) => I.order(a.id,b.id)),fields,instanceId:where.instanceId,occurrence};
  }
  function contextFor(doc, selected, options) {
    const {project,authority,revision} = options, store = options.store ?? G.AtriumUndoStore;
    const {instanceId,occurrence} = selected;
    const make = () => Q.context(project,doc,{authority,revision,store,instanceId,occurrence,
      defs:authority ? undefined : options.definitions()});
    if (revision == null || authority && stamp(authority) == null) return make();
    let documents = contexts.get(project);
    if (!documents) contexts.set(project,documents = new WeakMap());
    let entries = documents.get(doc);
    if (!entries) documents.set(doc,entries = []);
    const seq = store?.documentVersions?.(doc,project)?.seq;
    const library = store?.libraryVersion?.();
    const match = entries.find(e => e.revision === revision && e.seq === seq && e.library === library &&
      e.authority === authority && e.stamp === stamp(authority) && e.occurrence === occurrence);
    if (match) return match.context;
    const context = make();
    if (entries.length >= 8) entries.shift();
    entries.push({context,revision,seq,library,authority,stamp:stamp(authority),occurrence});
    return context;
  }
  function privateDependency(compiled, options, fields,doc) {
    const a = options.authority;
    if (!a || !(a.documentIds || a.canReadDocument || a.canReadItem)) return false;
    // Connectivity, signal classes and winning physical rules can aggregate
    // inputs from other owners. A partial grant cannot use that derived data.
    const schematicNet = field => doc.kind === "schematic" && /^(?:net|net\.name|hasnet)$/i.test(field);
    return compiled.kind === "net" || fields?.some(field=>schematicNet(field) || G.AtriumDesignQueryContext.signalField(field)) || compiled.dependencies.some(dep =>
      dep.startsWith("field:") && schematicNet(dep.slice(6)) ||
      /^(?:derived:signals|measurement:|rule:|geometry:|relation:(?!layer$|component$|sheet$)|field:(?:length|signal|paired|polarity))/.test(dep));
  }
  async function prepare(query,doc,selected,options) {
    const context = contextFor(doc,selected,options);
    const ready = await Q.prepare(query,context);
    const bad = options.check();
    if (bad) return bad;
    if (!ready.ok) return diagnosed(ready.diagnostics[0]);
    if (privateDependency(ready.plan,options,selected.fields,doc) || !ready.plan.authorized()) return denial();
    return {context,compiled:ready.plan,hints:ready.hints};
  }
  async function prepareDocuments(selected,options) {
    const prepared = [];
    for (const doc of selected.docs) {
      const ready = await prepare(selected.query,doc,selected,options);
      if (!ready.compiled) return ready;
      prepared.push(ready);
    }
    return options.check() || {prepared};
  }
  async function plan(input, opts = {}) {
    const options = request(opts), selected = scoped(input,options);
    if (!selected.docs) return selected;
    const ready = await prepareDocuments(selected,options);
    if (!ready.prepared) return ready;
    const plans = ready.prepared.map(({compiled,hints},i) => ({documentId:selected.docs[i].id,plan:compiled,hints:copy(hints)}));
    return {status:"ready",complete:true,snapshotId:options.revision,plans};
  }
  const wireRow = ({docId,...row}) => ({documentId:docId,...row});
  function cursorKey(query,selected,options) {
    const authority = options.authority;
    if (options.revision == null || authority && (!authority.id || stamp(authority) == null) || !G.AtriumFormat2) return null;
    const state = [options.project.id,options.revision,query,selected.docs.map(d => d.id),selected.instanceId,selected.fields,
      authority?.id,stamp(authority)];
    return G.AtriumFormat2.sha256(new TextEncoder().encode(JSON.stringify(state)));
  }
  async function search(input, opts = {}, maxRows = 200) {
    const options = request(opts), selected = scoped(input,options);
    if (!selected.docs) return selected;
    const limit = opts.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > maxRows)
      return failure("limit","Choose a result limit from 0 to " + maxRows + ".");
    const {query,docs,fields,instanceId} = selected;
    const cursor = opts.cursor, key = cursor ? cursorKey(query,selected,options) : null;
    if (cursor && (!key || cursor.key !== key || !Array.isArray(cursor.after) || cursor.after.length !== 3 ||
        !cursor.after.every(s => typeof s === "string" && !s.includes("\0") && s.length <= 1024) ||
        !docs.some(doc => doc.id === cursor.after[0]))) return failure("stale","The search cursor belongs to another snapshot or scope.");
    // A preview validates every document before showing matches and uses those plans to run it.
    let prepared;
    if (opts.onPrepared) {
      const ready = await prepareDocuments(selected,options);
      if (!ready.prepared) return ready;
      prepared = ready.prepared;
      const bad = options.check();
      if (bad) return bad;
      opts.onPrepared(copy(prepared.flatMap(row => row.hints)));
    }
    const afterId = cursor?.after.join("\0");
    const rows = [], summaries = [];
    let total = 0, visited = 0, unknown = 0, shown = false;
    const budget = opts.budget ?? {remaining:2000000,deadline:now()+30000};
    const publish = update => {
      if (!options.check() && opts.onPage) opts.onPage(copy(update));
    };
    function counting(batch, lowerBound) {
      shown = true;
      publish({status:"counting",complete:false,snapshotId:options.revision,lowerBound,rows:batch});
    }
    function incomplete(problem, bounds = 0) {
      const terminal = options.check() || problem;
      if (["cancelled","stale","denied","disabled"].includes(terminal.status)) return terminal;
      const result = {...terminal,status:total || bounds || rows.length || terminal.diagnostic.code === "measurement" ? "partial" : terminal.status,
        snapshotId:options.revision,lowerBound:total+bounds,rows:rows.slice(0,limit),visited,unknown};
      publish(result);
      return result;
    }
    for (const [i,doc] of docs.entries()) {
      if (!Array.isArray(doc.items)) return incomplete(failure("incomplete","The requested document has not been loaded."));
      const ready = prepared ? prepared[i] : await prepare(query,doc,selected,options);
      if (!ready.compiled) return incomplete(ready);
      const {compiled,context,hints} = ready;
      const args = {...options,instanceId,budget,isCurrent:() => !options.check()};
      const room = limit ? Math.max(0,limit + 1 - rows.length) : 0;
      const streamed = [];
      const result = await I.runDocument(compiled,context,{...args,fields,afterId,limit:room,pageSize:limit - rows.length,
        selection:maxRows > 1000,suggestions:opts.suggestions === true,
        onIndex:opts.onProjection && (() => opts.onProjection({doc,plan:compiled,context})),
        onPage:opts.onPage ? update => {
          if (update.complete) return;
          streamed.push(...update.rows.slice(0,Math.max(0,limit - rows.length - streamed.length)).map(wireRow));
          counting([...rows.slice(0,limit),...streamed],total+update.count);
        } : undefined,
      });
      const bad = options.check();
      if (bad) return bad;
      rows.push(...(result.rows || []).map((row,i) => streamed[i] ?? wireRow(row)));
      visited += result.checked ?? 0;
      unknown += result.unknown ?? 0;
      if (!result.complete) return incomplete(diagnosed(result.diagnostic),result.count ?? 0);
      total += result.count;
      if (opts.onPage && !shown && rows.length && (prepared || rows.length >= limit) && doc !== docs.at(-1))
        counting(rows.slice(0,limit),total);
      if (hints.length || result.suggestions?.length || result.measurements?.length)
        summaries.push({documentId:doc.id,hints,...(result.suggestions?.length ? {suggestions:result.suggestions} : {}),
          ...(result.measurements?.length ? {measurements:result.measurements} : {})});
    }
    const visible = rows.slice(0,limit), last = visible.at(-1);
    const nextKey = rows.length > limit ? key ?? cursorKey(query,selected,options) : null;
    const result = {status:"complete",complete:true,snapshotId:options.revision,count:total,rows:visible,visited,unknown,summaries,
      cursor:nextKey ? {key:nextKey,after:[last.documentId,last.instanceId || "",last.id]} : null};
    publish(result);
    return options.check() || result;
  }
  async function materialize(input, opts = {}, maxRows = 1000) {
    const result = await search(input,{...opts,limit:opts.limit ?? maxRows,onPage:undefined,cursor:undefined},maxRows);
    if (!result.complete || result.rows.length === result.count) return result;
    return {...failure("limit","The full result exceeds this consumer's row limit."),status:"partial",
      rows:result.rows,lowerBound:result.rows.length,snapshotId:result.snapshotId};
  }
  function canReadSaved(record,options) {
    const {scope,query} = record, a = options.authority;
    if (!a) return true;
    if (a.canReadSavedQuery?.(record.id) === false) return false;
    if (scope.documentId ? !readDoc(a,scope.documentId) : options.project.documents.some(doc => !readDoc(a,doc.id))) return false;
    return !a.canReadItem && !a.canReadField && !a.fields && !a.allowedFields &&
      (query.bindings || []).every(binding => !binding.target?.docId || readDoc(a,binding.target.docId));
  }
  function list(opts = {}) {
    const options = request(opts), bad = options.check();
    if (bad) return bad;
    const records = (options.project.savedQueries || []).filter(row => canReadSaved(row,options));
    return {status:"complete",complete:true,count:records.length,records:copy(records)};
  }
  function get(id,opts = {}) {
    const options = request(opts), bad = options.check();
    if (bad) return bad;
    const record = options.project.savedQueries?.find(row => row.id === id && canReadSaved(row,options));
    return record ? {status:"complete",complete:true,record:copy(record)} :
      options.authority ? denial() : failure("missing","The saved query is unavailable.");
  }
  function change(project,before,after,result) {
    const op = {op:"set",target:"project",path:["savedQueries"],after};
    if (Object.hasOwn(project,"savedQueries")) op.before = copy(before);
    return {result,ops:[op]};
  }
  async function save(input,opts = {}) {
    const options = request(opts,true), bad = options.check();
    if (bad) return {result:bad,ops:[]};
    if (!plain(input)) return {result:failure("record","Provide a saved query record."),ops:[]};
    const {project,authority} = options, previous = project.savedQueries ?? [];
    if (authority?.canReadItem || authority?.canReadField || authority?.fields || authority?.allowedFields ||
        project.documents.some(doc => !readDoc(authority,doc.id))) return {result:denial(),ops:[]};
    const existing = input.id == null ? null : previous.find(row => row.id === input.id);
    if (input.id != null && !existing) return {result:failure("missing","The saved query is unavailable."),ops:[]};
    if (!existing && previous.length >= R.savedLimit) return {result:failure("limit","This project already has 128 saved queries."),ops:[]};
    const scope = input.scope ?? existing?.scope ?? {};
    const keepScope = existing && scope.documentId === existing.scope.documentId && scope.instanceId === existing.scope.instanceId;
    const keepQuery = keepScope && (input.query === undefined || input.query === existing.query.source);
    const expression = keepQuery ? existing.query : input.query ?? existing?.query;
    if (!plain(scope) || Object.keys(scope).some(key => !["documentId","instanceId"].includes(key)))
      return {result:failure("scope","Invalid saved query scope."),ops:[]};
    const selection = scoped(expression,{...options,documentId:scope.documentId,instanceId:scope.instanceId,fields:input.columns ?? existing?.columns});
    if (!selection.docs && !keepQuery) return {result:selection,ops:[]};
    let bound = keepQuery ? existing.query : selection.query;
    if (!keepQuery) {
      for (const doc of selection.docs) {
        const ready = await prepare(selection.query,doc,selection,options);
        if (!ready.compiled) return {result:ready,ops:[]};
        if (ready.compiled.references.length) {
          if (selection.docs.length !== 1) return {result:failure("scope","Choose a document to save stable query bindings."),ops:[]};
          const rebound = Q.bind(selection.query,ready.context,{newId:() => G.AtriumUUID.next()});
          if (!rebound.ok) return {result:diagnosed(rebound.diagnostics[0]),ops:[]};
          bound = rebound.record;
        }
      }
    }
    const id = existing?.id ?? G.AtriumUUID.next(), record = {id,name:input.name ?? existing?.name,query:bound,scope,
      ...((input.columns ?? existing?.columns) ? {columns:input.columns ?? existing.columns} : {})};
    if (!R.validSaved(record)) return {result:failure("record","Invalid saved query name, scope or column list."),ops:[]};
    const after = copy(existing ? previous.map(row => row === existing ? record : row) : [...previous,record]);
    const result = {status:"complete",complete:true,record:copy(record)};
    const stopped = options.check();
    if (stopped) return {result:stopped,ops:[]};
    if (existing && (G.AtriumProposal?.equal(existing,record) ?? G.AtriumFormat2.canonical(existing) === G.AtriumFormat2.canonical(record)))
      return {result,ops:[]};
    return change(project,previous,after,result);
  }
  function remove(id,opts = {}) {
    const options = request(opts,true), bad = options.check();
    if (bad) return {result:bad,ops:[]};
    const {project,authority} = options, previous = project.savedQueries ?? [];
    if (authority?.canReadItem || authority?.canReadField || authority?.fields || authority?.allowedFields ||
        project.documents.some(doc => !readDoc(authority,doc.id))) return {result:denial(),ops:[]};
    const after = previous.filter(row => row.id !== id);
    if (after.length === previous.length) return {result:failure("missing","The saved query is unavailable."),ops:[]};
    return change(project,previous,copy(after),{status:"complete",complete:true,id});
  }
  function references(project, opts = {}) {
    const data = list({...opts,project});
    if (!data.complete) return data;
    return {status:"complete",complete:true,references:data.records.flatMap(record => R.references(record,project.id))};
  }
  const opaqueCandidates = new Set(["short","returnPathVia","diffPairsRouting","polygonConnect","matchedLengths","matchedDelays",
    "dfaSpacing","componentClearance","parallelSegment","returnPath","roomDefinition","routingTopology"]);
  function applicability(id, opts = {}) {
    const options = request(opts), bad = options.check();
    if (bad) return bad;
    const {project,authority,documentId} = options, Rules = G.AtriumRules, ERC = G.AtriumERC, P = G.AtriumProjectRules;
    if (authority && (authority.canReadItem || authority.canReadField || authority.fields || authority.allowedFields ||
        project.documents.some(doc => !readDoc(authority,doc.id)))) return denial();
    const limit = opts.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return failure("limit","Choose a preview limit from 1 to 200.");
    const doc = project.documents.find(d => d.id === documentId) ?? (!documentId && project.documents.find(d => d.kind === "pcb" || d.kind === "schematic"));
    if (!doc || !Array.isArray(doc.items)) return failure("document","Choose an available design document.");
    const defs = new Map(project.library.map(d => [d.id,d]));
    const DRC = doc.kind === "pcb" ? Rules?.compiled(doc,{project,defs}) : null;
    const stored = DRC?.set.list.find(r => r.id === id) ?? (project.rules?.list || []).find(r => r.id === id && P?.isErc(r.type));
    if (!stored) return failure("missing","The requested rule is unavailable.");
    const erc = P?.isErc(stored.type), domain = erc ? "erc" : "drc";
    if (!erc && !DRC || erc && doc.kind !== "schematic" && stored.type !== "ercBoardMismatch")
      return failure("document","Choose a document in the rule's check domain.");
    const sides = {scope:new Map(),scope2:new Map()}, winners = new Map(), pairs = new Map();
    let unqualifiedPair = false;
    const terminalIds = new WeakMap();
    const idOf = row => I.idOf({id:row.id,docId:row.documentId,instanceId:row.instanceId});
    function children(parent) {
      if (terminalIds.has(parent)) return terminalIds.get(parent);
      const occurrences = new Map();
      const ids = G.Atrium.pins(parent,defs.get(parent.def),doc.kind).map(pin => {
        const number = String(pin.number ?? ""), seen = occurrences.get(number) || 0;
        occurrences.set(number,seen+1);
        return I.terminalId(parent.id,pin,number,seen);
      });
      terminalIds.set(parent,ids);
      return ids;
    }
    const ref = subject => {
      if (!subject) return null;
      const itemId = subject.id ?? (subject.kind === "net" && "net/"+subject.net);
      if (!itemId) return null;
      const row = {documentId:doc.id,id:itemId,kind:subject.kind ?? "object"};
      if (subject.kind === "pad" && subject.parent && Number.isSafeInteger(subject.padIndex)) {
        row.id = children(subject.parent)[subject.padIndex] ?? itemId;
        row.ownerId = subject.parent.id;
      }
      for (const key of ["instanceId","ownerId","pin","padIndex"]) if (subject[key] != null) row[key] = subject[key];
      return row;
    };
    function remember(map, subject) {
      const row = ref(subject);
      if (row) map.set(idOf(row),row);
    }
    function winningPair(a,b) {
      remember(winners,a); remember(winners,b);
      rememberPair(a,b);
    }
    function rememberPair(a,b) {
      const one = ref(a), two = ref(b);
      if (!one || !two) { unqualifiedPair = true; return; }
      const ordered = [one,two].sort((x,y) => I.order(idOf(x),idOf(y)));
      pairs.set(JSON.stringify(ordered.map(idOf)),ordered);
    }
    let violations = [], diagnostics = [], enabled, coverage;
    if (!erc) {
      const sameType = DRC.byType[stored.type] || [], focus = sameType.find(r => r.id === id);
      enabled = Rules.ruleActive(DRC.set,stored);
      diagnostics = DRC.diagnostics.filter(d => d.type === stored.type);
      if (focus) {
        const geo = Rules.kit.extract(doc,defs,{padSlots:true});
        for (const list of Rules.kit.scopeObjects(doc,defs,DRC.set,geo)) for (const subject of list) {
          if (focus.m1(subject)) remember(sides.scope,subject);
          if (focus.m2?.(subject)) remember(sides.scope2,subject);
        }
        const traced = {...DRC,
          first(type,subject) {
            const rule = DRC.first(type,subject);
            if (type === stored.type && type !== "zClearance" && rule?.id === id) remember(winners,subject);
            return rule;
          },
          either(type,a,b) {
            const rule = DRC.either(type,a,b);
            if (type === stored.type && rule?.id === id) {
              if (focus.m1(a)) remember(winners,a);
              if (focus.m1(b)) remember(winners,b);
              rememberPair(a,b);
            }
            return rule;
          },
          pair(type,a,b) {
            const rule = DRC.pair(type,a,b);
            if (type === stored.type && rule?.id === id) winningPair(a,b);
            return rule;
          },
          ...(DRC.clearanceRule && {clearanceRule(a,b) {
            const rule = DRC.clearanceRule(a,b);
            if (stored.type === "clearance" && rule?.id === id) winningPair(a,b);
            return rule;
          }})
        };
        const checkable = Rules.checkedTypes.includes(stored.type) ||
          stored.type === "routingTopology" && Rules.topologyChecked.includes(stored.topology);
        const scopeIssues = [...DRC.measurementIssues.values()];
        if (checkable) {
          const checked = Rules.drc(doc,defs,Rules.stored(doc,project),{compiled:traced,project,types:[stored.type],limit,scopes:false,geo,
            onRulePair(rule,a,b) { if (rule.id === id) winningPair(a,b); }});
          violations = checked.violations.filter(issue => issue.ruleId === id && !issue.scopeDiagnostic).map(issue => ({
            id:issue.id,otherId:issue.otherId,type:issue.type,actual:issue.actual,required:issue.required}));
          diagnostics = checked.diagnostics;
          for (const note of checked.notes) if (/\b(?:needs?|unavailable|skipped|out of date|unsupported shapes)\b/i.test(note))
            diagnostics.push({code:"coverage",message:note});
        }
        for (const issue of scopeIssues) if (!diagnostics.some(d => d.ruleId === issue.ruleId && d.side === issue.side && d.code === issue.code))
          diagnostics.push(issue);
        if (unqualifiedPair) diagnostics.push({code:"coverage",message:"A check candidate pair has no selectable object identity."});
        const traceable = checkable && !Rules.isXsScope(stored) && !opaqueCandidates.has(stored.type);
        coverage = traceable && !diagnostics.some(d => d.code === "coverage") ? "check-candidates" : "scope-only";
        if (!traceable)
          diagnostics.push({code:"domain",message:"This rule's kernel does not expose a check-candidate preview."});
      }
    } else {
      enabled = stored.enabled !== false;
      coverage = "reported-check-subjects";
      if (enabled && (stored.type === "ercNetScope" || stored.type === "ercCalculationAssertion" || !ERC)) {
        coverage = "none";
        diagnostics.push({code:"domain",message:"This rule's kernel does not expose a check-subject preview."});
      } else if (enabled) {
        const scoped = ERC.scopedRules(project);
        const focus = scoped?.byType.get(stored.type)?.find(r => r.id === id)?.sheets.get(doc);
        const fallbackScope = !stored.sheets && R.isAll(stored.scope), selected = new Set();
        const checked = ERC.run(project,{scoped,calculationSnapshot:null,onCheck(check,owner,subject,rule,issue) {
          if (owner !== doc || P.ercType(check) !== stored.type) return;
          if (fallbackScope || focus?.matches(subject)) remember(sides.scope,subject);
          if (rule?.id !== id) return;
          remember(winners,subject);
          if (issue) selected.add(issue);
        }});
        violations = checked.messages.filter(issue => selected.has(issue)).slice(0,limit).map(issue => ({
          id:issue.objectId,type:issue.check,severity:issue.class,signature:issue.sig}));
        diagnostics = (scoped?.diagnostics || []).filter(d => d.type === stored.type && d.documentId === doc.id);
      }
    }
    const stopped = options.check();
    if (stopped) return stopped;
    const items = map => [...map].sort(([a],[b]) => I.order(a,b)).slice(0,limit).map(([,value]) => value);
    const result = {status:diagnostics.length ? "partial" : "complete",complete:!diagnostics.length,domain,coverage:coverage ?? "none",
      ruleId:id,documentId:doc.id,enabled,snapshotId:options.revision,scope:{rows:items(sides.scope),count:sides.scope.size},
      scope2:{rows:items(sides.scope2),count:sides.scope2.size},winners:{rows:items(winners),count:winners.size},
      pairs:{rows:items(pairs),count:pairs.size},violations,diagnostics};
    return result;
  }
  return Object.freeze({plan,search:(input,opts) => search(input,opts),
    count:(input,opts) => search(input,{...opts,limit:0}),materialize:(input,opts) => materialize(input,opts),
    selection:(input,opts) => materialize(input,{...opts,limit:50000,fields:[]},50000),list,get,save,remove,references,applicability});
})();
