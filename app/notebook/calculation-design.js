"use strict";
// Projects the authored fields needed by a calculation closure. The browser
// reuses the edit journal, and frozen consumers use the same projection.
globalThis.AtriumCalculationDesign = (() => {
  const G = globalThis;
  const graph = () => G.AtriumCalculationGraph;
  const records = () => G.AtriumCalculationRecords;
  const notes = () => G.AtriumNoteFields;
  const defaultTypes = Object.freeze(["resistor", "capacitor", "inductor"]);
  const folded = s => String(s ?? "").toLowerCase();
  const assignment = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*=(?!=)/u;
  const nameOf = b => b.name || assignment.exec(b.source)?.[1] || "";
  const authored = i => records()?.isBlock(i) ? records().read(i) : null;
  const fieldKey = t => notes()?.key?.(t) || JSON.stringify([t.scope, t.docId || "", t.itemId || t.signalId || "", t.instanceId || "", folded(t.field)]);
  const registryKey = registry => JSON.stringify(Object.entries(registry).sort(([a], [b]) => a.localeCompare(b))
    .map(([id, d]) => [id, d.version, d.digest || d.packageDigest || d.expression]));
  const watchKey = (...parts) => JSON.stringify(parts);
  function fieldWatches(t) {
    if (t.scope === "numeric-field") {
      const address=t.address;if(!address)return [];
      return address.scope === "item" ? [watchKey("item",address.documentId,address.itemId),watchKey("doc",address.documentId)] :
        [watchKey("doc",address.documentId)];
    }
    if (t.scope === "query") return [watchKey("query",t.docId ?? null),"library","defaults","parameters","signals","project"];
    if (t.scope === "item") return [watchKey("item", t.docId, t.itemId), watchKey("doc", t.docId), "library", "defaults", "parameters", "project"];
    if (t.scope === "sheet") return [watchKey("sheet", t.docId), watchKey("doc", t.docId), "parameters"];
    if (t.scope === "signal") return ["signals", ...(t.docId ? [watchKey("doc", t.docId)] : [])];
    return ["project", "parameters"];
  }
  // The same environment keys apply to editor journal rows and guarded native proposal operations.
  function environmentWatches(path) {
    const [head,field]=path;
    if(head==="parameters")return ["parameters"];
    if(head==="library")return ["library"];
    if(head==="rules")return field && field!=="calculationTolerances" ? ["project"] : ["defaults","project"];
    if(head==="signals")return ["signals","project"];
    if(["documents","variants","multichannel","hierarchy","projectFields"].includes(head) || !head)return ["project"];
    return [];
  }
  const fault = (code, message) => ({code, message});
  const denied = () => fault("denied","The requested design data is unavailable.");
  function readable(project,authority,documentId) {
    if (!authority) return true;
    if (authority.revoked || authority.readProject===false || authority.projectId && authority.projectId!==project?.id) return false;
    if (documentId==null) return true;
    if (authority.canReadDocument && !authority.canReadDocument(documentId)) return false;
    const ids=authority.documentIds;
    return !ids || (Array.isArray(ids) ? ids.includes(documentId) : !!ids.has?.(documentId));
  }

  function addTo(map, key, value) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(value);
  }
  function removeFrom(map, key, value) {
    const set = map.get(key);
    if (set?.delete(value) && !set.size) map.delete(key);
  }

  function create(sourceProject, store = null, authority) {
    // A restricted name lookup never observes candidates on inaccessible sheets.
    const project=authority ? {...sourceProject,documents:(sourceProject.documents || []).filter(d=>readable(sourceProject,authority,d.id))} : sourceProject;
    const fieldAllowed=key=>!authority?.canReadField || !!authority.canReadField(folded(key));
    const allowed=t=>!authority || readable(sourceProject,authority,t?.docId) && fieldAllowed(t?.field);
    let stamp = Symbol(), environment = null, defaults = {}, functions = {}, functionStamp = "";
    let docs = new Map(), instances = new Map(), hierarchyStamp = "", ruleOptions = new Map();
    const sheets = new Map(), nodes = new Map(), byBlock = new Map(), reverse = new Map(), values = new Map();
    const fields = new Map(), affected = new Map(), aliases = new Map(), queryNodes = new Set();
    const tracked = new Map(), changedInputs = new Set();
    let reads = 0;

    function invalidate(keys) {
      const dirty = new Set(keys);
      for (const key of dirty) {
        values.delete(key);
        for (const dependant of reverse.get(key) || []) dirty.add(dependant);
      }
    }

    function forgetFields(user, references) {
      for (const r of references) {
        if (!r.fieldKey) continue;
        const field = fields.get(r.fieldKey);
        if (field?.users.delete(user) && !field.users.size) {
          for (const watch of field.watches) removeFrom(affected, watch, r.fieldKey);
          fields.delete(r.fieldKey);
        }
      }
    }
    function forgetNode(key) {
      const node = nodes.get(key);
      if (!node) return;
      for (const r of node.references) if (r.dependency) removeFrom(reverse, r.dependency, key);
      forgetFields(key,node.references);
      nodes.delete(key); queryNodes.delete(key);
    }

    function changedBlock(docId, id) {
      const index = watchKey(docId, id), keys = byBlock.get(index) || [];
      // Keep edges into a missing calculation so an Undo that restores its ID
      // repairs the dependent records, including records evaluated while broken.
      const results = docInstances(docId).map(instanceId => graph().keyOf(docId, id, instanceId));
      invalidate([...keys, ...results]);
      for (const key of keys) forgetNode(key);
      byBlock.delete(index);
    }

    function putBlock(state, id, item) {
      const old = state.blocks.get(id), block = authored(item);
      if (!block) {
        if (old) { changedBlock(state.doc.id, id); state.blocks.delete(id); }
        return;
      }
      const signature = JSON.stringify([block.languageVersion, block.source, block.name, block.displayUnit, block.bindings, block.assertions, block.functions]);
      if (!old || old.signature !== signature) changedBlock(state.doc.id, id);
      state.blocks.set(id, {block, signature});
    }

    function fullSheet(state) {
      const seen = new Set();
      for (const item of state.doc.items || []) if (records().isBlock(item)) {
        putBlock(state, item.id, item);
        seen.add(item.id);
      }
      for (const id of state.blocks.keys()) if (!seen.has(id)) putBlock(state, id, null);
    }

    function sheet(docId) {
      const doc = docs.get(docId);
      if (doc?.kind !== "schematic") return null;
      let state = sheets.get(docId);
      if (!state) {
        state = {doc, blocks: new Map(), version: store?.documentVersions?.(doc, project) || null};
        fullSheet(state);
        sheets.set(docId, state);
      }
      return state;
    }

    function updateInstances(v, documentIds) {
      // With a live journal, ordinary part edits never ask the hierarchy to
      // enumerate instances. Frozen projects have no edits and compute it once.
      const version = v != null ? JSON.stringify([documentIds, v]) : null;
      if (version != null && version === hierarchyStamp) return;
      const next = new Map();
      for (const i of G.AtriumHierarchy?.instances?.(project)?.instances || []) {
        if (!next.has(i.doc.id)) next.set(i.doc.id, []);
        next.get(i.doc.id).push(i.parent ? i.id : null);
      }
      const structure = JSON.stringify([...next]);
      if (environment && structure !== environment.hierarchyStructure) {
        invalidate(nodes.keys());
        for (const key of nodes.keys()) forgetNode(key);
        byBlock.clear();
      }
      instances = next;
      hierarchyStamp = version;
      return structure;
    }

    function docInstances(docId) { return instances.get(docId) || [null]; }
    function instanceFor(docId, id) {
      const available = docInstances(docId);
      if (id === docId && available.includes(null)) return null;
      return id == null && available.length === 1 ? available[0] : id ?? null;
    }


    function readField(t, name, documentId) {
      reads++;
      if (t.detached || t.needsRebind) return {diagnostic: fault("needs-rebind", "Choose a new source for " + name + ".")};
      if (t.docId && !docs.has(t.docId)) return {diagnostic: fault("missing-document", "The source sheet for " + name + " is unavailable.")};
      const doc = docs.get(t.docId || documentId);
      const r = notes()?.resolve(project, doc, name, t, {instanceId:t.instanceId ?? undefined, describeField:G.AtriumQueryFields?.describe});
      if (!r || r.broken || r.raw == null || r.raw === "") {
        return {diagnostic: fault(r?.code || "broken-reference", "The design field for " + (r?.label || name) + " is unavailable.")};
      }
      if (r.declaration?.diagnostic) return {diagnostic:r.declaration.diagnostic};
      const component = t.scope === "item" && defaultTypes.includes(r.kind);
      const inline = typeof r.raw === "string" && /±|\+\/-/.test(r.raw);
      const requireVoltage = t.scope === "signal" && folded(t.field) === "voltage";
      let raw = r.raw, tolerance = r.tolerance ?? undefined;
      let toleranceSource = tolerance != null || inline ? "explicit" : undefined;
      if (!inline && typeof tolerance === "string") {
        raw = String(raw) + " ± " + tolerance.trim().replace(/^(?:±|\+\/-)\s*/, "");
        tolerance = undefined;
      } else if (typeof tolerance === "number") tolerance = {absolute: tolerance};
      if (component && !toleranceSource) {
        const assumed = defaults[r.kind];
        if (Number.isFinite(assumed)) { tolerance = {relative: assumed}; toleranceSource = "default"; }
        else toleranceSource = "unknown";
      } else if (!component && toleranceSource == null) {
        tolerance = {absolute: 0};
      }
      const unit = requireVoltage ? (r.authoredUnit || (r.provenance === "confirmed signal" ? "V" : "")) :
        (r.declaration?.unit ?? r.defaultUnit ?? "");
      return {requireVoltage, field: {
        raw, unit, fieldUnit:unit || undefined, sourceId: r.sourceId || fieldKey(t), label: r.label || name,
        toleranceLabel: component ? (r.label || name).replace(/\.value$/i, "") : (r.label || name),
        kind: r.kind, tolerance, toleranceSource, provenance: toleranceSource === "default" ? "Project rules" : r.provenance,
        toleranceProvenance: r.toleranceSource
      }};
    }

    function refreshField(key) {
      const before = fields.get(key);
      if (!before) return;
      const data = readField(before.target, before.name, before.documentId), serial = JSON.stringify(data);
      if (before.serial === serial) return;
      before.data = data;
      before.serial = serial;
      invalidate(before.users);
      for (const user of before.users) if (tracked.has(user)) changedInputs.add(user);
    }

    function sync(revision, registry = {}) {
      const nextFunctions = registryKey(registry);
      if (stamp === revision && functionStamp === nextFunctions) return;
      if (stamp!==revision && queryNodes.size) invalidate(queryNodes);
      stamp = revision;
      aliases.clear();
      if (functionStamp !== nextFunctions) {
        functions = registry;
        functionStamp = nextFunctions;
        invalidate(nodes.keys());
      }

      const versions = new Map();
      docs = new Map((project.documents || []).map(d => [d.id, d]));
      const versionOf = doc => {
        if (!versions.has(doc.id)) versions.set(doc.id, store?.documentVersions?.(doc, project) || null);
        return versions.get(doc.id);
      };
      const first = docs.values().next().value, version = first && versionOf(first);
      const topology = updateInstances(store?.hierarchyVersion?.(project), [...docs.keys()]);
      const nextDefaults = project.rules?.calculationTolerances || {}, toleranceStamp = JSON.stringify(nextDefaults);
      const toRead = new Set(), queue = key => { for (const id of affected.get(key) || []) toRead.add(id); };
      if (environment) for (const id of docs.keys()) if (!environment.documentIds.has(id)) queue(watchKey("doc", id));

      for (const [id, old] of sheets) {
        const doc = docs.get(id);
        if (doc?.kind !== "schematic") {
          for (const objectId of old.blocks.keys()) changedBlock(id, objectId);
          sheets.delete(id);
          queue(watchKey("doc", id));
          continue;
        }
        const v = versionOf(doc), prev = old.version;
        const diff = old.doc === doc && prev && v && store?.recordedChanges?.(doc, prev.seq);
        old.doc = doc;
        old.version = v;
        if (diff?.ids) {
          for (const objectId of diff.ids) {
            putBlock(old, objectId, diff.items.get(objectId));
            queue(watchKey("item", id, objectId));
          }
        } else {
          fullSheet(old);
          queue(watchKey("doc", id));
        }
        if (!v || !prev || v.outer !== prev.outer) queue(watchKey("sheet", id));
      }

      if (environment) {
        // A watched field can also be in a document with no calculation blocks.
        for (const [id, old] of environment.fieldDocs) {
          if (sheets.has(id)) continue;
          const doc = docs.get(id), v = doc && versionOf(doc);
          const diff = doc === old.doc && v && old.version && store?.recordedChanges?.(doc, old.version.seq);
          if (diff?.ids) for (const objectId of diff.ids) queue(watchKey("item", id, objectId));
          else queue(watchKey("doc", id));
          if (!v || !old.version || v.outer !== old.version.outer) queue(watchKey("sheet", id));
        }
        if (!version || !environment.version || version.library !== environment.version.library) queue("library");
        if (!version || !environment.version || version.parameters !== environment.version.parameters) queue("parameters");
        if (!version || !environment.version || version.project !== environment.version.project) queue("project");
        if (!version || !environment.version || version.project !== environment.version.project || project.signals !== environment.signals) queue("signals");
        if (toleranceStamp !== environment.toleranceStamp) queue("defaults");
      }
      defaults = nextDefaults;
      ruleOptions = new Map((project.rules?.list || []).filter(r => r.type === "ercCalculationAssertion")
        .map(r => [watchKey(r.origin?.object, r.origin?.assertion), r]));
      for (const key of toRead) refreshField(key);
      const fieldDocs = new Map();
      for (const id of environment?.fieldDocs.keys() || []) {
        if (affected.has(watchKey("doc", id)) && docs.has(id)) fieldDocs.set(id, {doc: docs.get(id), version: versionOf(docs.get(id))});
      }
      environment = {version, fieldDocs, documentIds: new Set(docs.keys()), signals: project.signals, toleranceStamp,
        hierarchyStructure: topology ?? environment?.hierarchyStructure};
    }

    function relativeTarget(t, context) {
      if (t.docId !== context.documentId || t.instanceId != null || context.instanceId == null) return t;
      return {...t, instanceId: context.instanceId};
    }

    function linkReference(binding, context, user) {
      const t = binding.target && relativeTarget(binding.target, context);
      const r = {id: binding.id, name: binding.name, span: binding.span, target: t};
      if (!t) return {...r, diagnostic: fault("unbound", "Choose a design field for " + binding.name + ".")};
      if (!allowed(t)) return {...r, target:null, diagnostic:denied()};
      if (!t.detached && !t.needsRebind && t.scope === "item" && t.field === "result") {
        return {...r, dependency: graph().keyOf(t.docId, t.itemId, instanceFor(t.docId, t.instanceId))};
      }
      // An ad hoc Answer reads fields without extending the authored graph.
      if (!user) return {...r, ...readField(t, binding.name, context.documentId)};
      const key = watchKey(fieldKey(t), !!(t.detached || t.needsRebind));
      let entry = fields.get(key);
      if (!entry) {
        const data = readField(t, binding.name, context.documentId), watches = fieldWatches(t);
        entry = {target: t, name: binding.name, documentId: context.documentId, data, serial: JSON.stringify(data), watches, users: new Set()};
        fields.set(key, entry);
        for (const watch of watches) addTo(affected, watch, key);
        const doc = docs.get(t.docId);
        if (doc) environment.fieldDocs.set(doc.id, {doc, version: store?.documentVersions?.(doc, project) || null});
      }
      entry.users.add(user);
      return {...r, fieldKey: key};
    }

    function getNode(key) {
      if (nodes.has(key)) return nodes.get(key);
      const [documentId, blockId, instanceId, clauseId] = JSON.parse(key);
      const block = sheet(documentId)?.blocks.get(blockId)?.block;
      if (!block || !docInstances(documentId).includes(instanceId)) return null;
      const record = clauseId == null ? block : block.assertions?.find(r => r.id === clauseId);
      if (!record) return null;
      const context = {documentId, blockId, instanceId, clauseId};
      const refs = (record.bindings || []).map(b => linkReference(b, context, key));
      const n = {...context, key, source: record.source, label: nameOf(block) || blockId, displayUnit: clauseId == null ? block.displayUnit : undefined,
        languageVersion: block.languageVersion, functions: block.functions || {}, references: refs};
      if (graph().countQueries(n.source).length) queryNodes.add(key);
      nodes.set(key, n);
      addTo(byBlock, watchKey(documentId, blockId), key);
      for (const r of refs) if (r.dependency) addTo(reverse, r.dependency, key);
      return n;
    }

    function selections(o = {}) {
      const out = [], ids = o.documentId ? [o.documentId] : [...docs.keys()];
      for (const id of ids) {
        const state = sheet(id);
        if (!state) continue;
        const contexts = o.instanceId != null ? [instanceFor(id, o.instanceId)] : docInstances(id);
        const list = o.blockId ? [state.blocks.get(o.blockId)].filter(Boolean) :
          [...state.blocks.values()].sort((a, b) => a.block.id < b.block.id ? -1 : a.block.id > b.block.id ? 1 : 0);
        for (const {block} of list) for (const instanceId of contexts) {
          const key = graph().keyOf(id, block.id, instanceId);
          const clauses = (block.assertions || []).map(a => {
            const rule = ruleOptions.get(watchKey(block.id, a.id));
            return {id:a.id, enabled:rule?.enabled !== false && rule?.severity !== "off", scopeIssue:G.AtriumCalculationChecks?.scopeDiagnostic(rule),
              key:a.id === block.primaryAssertionId ? key : graph().keyOf(id, block.id, instanceId, a.id)};
          });
          const primary = clauses.find(a => a.key === key);
          out.push({documentId:id, blockId:block.id, instanceId, key, clauses, disabled:primary?.enabled === false, scopeIssue:primary?.scopeIssue});
        }
      }
      return out;
    }

    function plan(o = {}, adhoc) {
      const selection = adhoc ? [] : selections(o);
      const roots = adhoc ? [adhoc.key] : selection.flatMap(r => [
        ...(r.disabled || r.scopeIssue ? [] : [r.key]), ...r.clauses.filter(c => c.enabled && !c.scopeIssue).map(c => c.key)
      ]).filter(k => !values.has(k));
      const visited = new Set(roots), known = [], rows = [];
      for (const key of visited) {
        if (onCache(key)) continue;
        const node = adhoc?.key === key ? adhoc : getNode(key);
        if (!node) continue;
        const refs = node.references.map(r => r.fieldKey ? {...r, ...fields.get(r.fieldKey)?.data} : r);
        rows.push({...node, references: refs});
        for (const r of refs) if (r.dependency) visited.add(r.dependency);
      }
      function onCache(key) { if (!values.has(key)) return false; known.push([key, values.get(key)]); return true; }
      return {selection, request: {operation: "graph", roots, nodes: rows, known, functions}};
    }

    function accept(response, except) { for (const [key, row] of response.changed) if (key !== except) values.set(key, row); }

    function snapshot(selection, stats, revision = stamp) {
      const out = [];
      const read = (key, issue) => issue ? {result:{ok:false,diagnostic:issue}, inputs:[]} : values.get(key);
      for (const {documentId, blockId, instanceId, key, clauses, disabled, scopeIssue} of selection) {
        const item = disabled ? {result: graph().failed("disabled", "Disabled", [0, 0]), inputs: []} : read(key,scopeIssue);
        if (!item) continue;
        const assertions = clauses.map(c => {
          const row = c.enabled ? read(c.key,c.scopeIssue) : null;
          const status = !c.enabled ? "disabled" : row?.result?.assertion?.status || (row ? "incomplete" : "pending");
          return {id: c.id, enabled: c.enabled, status, ...row};
        });
        out.push({documentId, blockId, instanceId, ...item, assertions});
      }
      return {revision, records: out, stats: {...stats, reads}};
    }

    function nameMatches(name, context) {
      const search = folded(name), out = [];
      for (const [docId, doc] of docs) {
        const qualified = [doc.id, doc.name].flatMap(n => [folded(n) + ".", folded(n) + "::"]).find(prefix => search.startsWith(prefix));
        const wanted = qualified ? search.slice(qualified.length) : search;
        const state = sheet(docId);
        if (!state) continue;
        for (const {block} of state.blocks.values()) {
          if (!nameOf(block) || folded(nameOf(block)) !== wanted) continue;
          const ids = docId === context.documentId && context.instanceId != null ? [context.instanceId] : docInstances(docId);
          for (const instanceId of ids) out.push({label: nameOf(block) + " · " + doc.name + (instanceId ? " · " + instanceId : ""), binding: {
            scope: "item", docId, itemId: block.id, instanceId: instanceId ?? undefined, field: "result"
          }});
        }
      }
      return out;
    }

    function resolveName(context, name) {
      const key = JSON.stringify([context.documentId, context.instanceId, name]);
      if (aliases.has(key)) return aliases.get(key);
      if (!readable(sourceProject,authority,context.documentId)) return {diagnostic:denied()};
      const dot=name.lastIndexOf("."), field=dot<0 ? "value" : name.slice(dot+1);
      const readValue=fieldAllowed(field), readResult=fieldAllowed("result");
      if (!readValue && (dot>=0 || !readResult)) return {diagnostic:denied()};
      const found = readValue && notes()?.resolve(project, docs.get(context.documentId), name, null, {instanceId: context.instanceId ?? undefined});
      const alternatives = readResult ? nameMatches(name, context) : [];
      if (found?.binding && !found.broken) alternatives.push({label: found.label, binding: found.binding});
      else for (const c of found?.candidates || []) if (c.binding) alternatives.push(c);
      let result;
      if (alternatives.length === 1) result = {binding: alternatives[0].binding, label: alternatives[0].label};
      else if (alternatives.length > 1) result = {candidates: alternatives, diagnostic: fault("ambiguous", "Choose which design field " + name + " refers to.")};
      else result = {diagnostic: fault(found?.code || "unbound", "Choose a design field for " + name + ".")};
      if (aliases.size >= 256) aliases.delete(aliases.keys().next().value);
      aliases.set(key, result);
      return result;
    }

    function query(key, source, context, references, functions) {
      return {key, source, documentId: context.documentId, blockId: null, instanceId: context.instanceId ?? null, fieldUnit:context.fieldUnit,
        references: references.map(r => r.target ? linkReference(r, context, null) : r), functions};
    }

    function trackInputs(user, context, references) {
      if (tracked.has(user)) forgetFields(user,tracked.get(user));
      changedInputs.delete(user);
      if (references.length) tracked.set(user,references.map(r => r.target ? linkReference(r,context,user) : r));
      else tracked.delete(user);
    }

    function readInputs(user) {
      return (tracked.get(user) || []).map(r => r.fieldKey ? {...r,...fields.get(r.fieldKey)?.data} : r);
    }

    function takeInputChanges() {
      const changed = [...changedInputs];
      changedInputs.clear();
      return changed;
    }

    function watchTargets(query) {
      const out = new Map(), seen = new Set([query.key]), pending = [query];
      while (pending.length) {
        const node=pending.pop();
        if(graph().countQueries(node.source).length){const target={scope:"query",docId:node.documentId};out.set(JSON.stringify(target),target);}
        for (const r of node.references) {
        if (r.target) out.set(JSON.stringify(r.target), r.target);
        if (r.dependency && !seen.has(r.dependency)) {
          seen.add(r.dependency);
          const dependency = getNode(r.dependency);
          if (dependency) pending.push(dependency);
        }
      }}
      return [...out.values()];
    }
    return Object.freeze({sync, plan, accept, snapshot, resolveName, query, watchTargets, allowed,
      trackInputs,readInputs,takeInputChanges});
  }

  return Object.freeze({create, fieldKey, fieldWatches, watchKey, environmentWatches, registryKey, readable});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumCalculationDesign;
