"use strict";
// One source owns its references. A journal update revisits only touched records.
globalThis.AtriumLinks = (() => {
  const G = globalThis;
  const R = G.AtriumLinkRecord;
  const {parse, format, extract, address, validSource, validRecord, validAnchor, authoredRecord, id, shortLabel, fragmentPattern} = R;
  const list = value => Array.isArray(value) ? value : [];
  const entries = value => Object.values(value ?? {});
  const bucket = target => target.projectId + "/" + target.objectId;
  const targetKey = target => bucket(target) + (target.fragment ? "#" + target.fragment : "");
  const sourceData = ({objectId, documentId, kind}) => ({objectId, ...(documentId && {documentId}), kind});
  function locationOf({objectId, documentId, kind, label, presentedId, point, net}) {
    if (!id(objectId) || !kind) return null;
    return {objectId, ...(documentId && {documentId}), kind, label:shortLabel(label) || kind,
      ...(presentedId && {presentedId}), ...(point && {point:[...point]}), ...(net && {net})};
  }
  function putLocation(targets, row) {
    const location = locationOf(row);
    if (!location) return null;
    const {owner, objectId} = row;
    if (!targets.has(objectId)) targets.set(objectId, new Map());
    targets.get(objectId).set(owner, location);
    return location;
  }
  const locationsOf = (targets, objectId) => [...targets.get(objectId)?.values() ?? []];

  function recordTargets(record, projectId) {
    const found = new Map();
    function add(value, field) {
      if (!address(value)) return;
      const {projectId, objectId, fragment} = value;
      const target = {projectId, objectId, ...(fragment && {fragment})};
      found.set(targetKey(target), {target, field});
    }
    const local = (objectId, field) => add({projectId, objectId}, field);
    const text = (value, field = "text") => { for (const target of extract(value)) add(target, field); };
    const binding = (value, field) => {
      if (!value) return;
      const owner = value.projectId ?? projectId;
      const objectId = value.itemId ?? value.signalId ?? value.docId ?? owner;
      add({projectId:owner, objectId}, field);
    };
    const query = (value, field) => {
      for (const ref of G.AtriumDesignQueryRecord.references(value, projectId)) add(ref.target, field);
    };

    text(record.text);
    text(record.source);
    text(record.notes);
    for (const block of list(record.richText?.blocks)) for (const run of list(block.runs)) {
      text(run.href);
      text(run.text);
      binding(run.binding, "field");
    }
    for (const key of ["scope", "scope2", "scopeRecord"]) if (record[key]?.bindings) query(record[key], key);
    if (record.query) query(record.scope ? record : record.query, "query");
    for (const {source, bindings, field} of G.AtriumCalculationRecords.references(record)) {
      text(source, field);
      for (const row of bindings) binding(row.target, field);
    }
    if (record.type === "thread") {
      local(record.anchor?.id, "anchor");
      for (const objectId of list(record.anchor?.ids)) local(objectId, "anchor");
    } else if (record.type === "reply") local(record.thread, "thread");
    if (record.callout?.anchor) local(record.callout.anchor.itemId, "anchor");
    if (record.widget?.type === "link") text(record.widget.state?.url);
    if (record.widget?.type === "todo") for (const row of list(record.widget.state?.rows)) {
      local(row.link?.itemId, "item");
      local(row.threadId, "thread");
    }
    if (record.source?.kind === "savedView") local(record.source.savedViewId, "source");
    if (record.source?.kind === "frame") local(record.source.frameId, "source");
    if (record.documentId) local(record.documentId, "document");
    for (const objectId of list(record.selection)) local(objectId, "selection");
    const filter = record.filter?.scope;
    if (filter?.savedQueryId) local(filter.savedQueryId, "filter");
    else if (filter) query(filter, "filter");
    return [...found];
  }

  // Each authored row owns its outgoing edges. Replacing one source rewrites only
  // that source and the affected incoming buckets. Neither query reruns the crawl.
  function createIndex(projectId) {
    const targets = new Map(), outgoing = new Map(), incoming = new Map(), owned = new Map(), pinned = new Map(), externals = new Map();
    const stats = {records:0, edges:0};
    function replaceEdges(key, edges) {
      for (const edge of outgoing.get(key) ?? []) {
        const name = bucket(edge.target), index = incoming.get(name);
        index.delete(edge.key);
        if (!index.size) incoming.delete(name);
      }
      if (!edges.length) outgoing.delete(key);
      else outgoing.set(key, edges);
      for (const edge of edges) {
        const name = bucket(edge.target);
        if (!incoming.has(name)) incoming.set(name, new Map());
        incoming.get(name).set(edge.key, edge);
      }
      stats.edges += edges.length;
    }
    function put(row) {
      const location = putLocation(targets, row);
      if (!location) return;
      const {owner, objectId, record, refs} = row;
      const key = owner + "/" + objectId;
      if (!owned.has(owner)) owned.set(owner, new Set());
      owned.get(owner).add(objectId);
      const references = refs ?? (record ? recordTargets(record, projectId) : []);
      replaceEdges(key, references.map(([name, ref]) => ({key:key + "/" + name, source:sourceData(location), target:ref.target, field:ref.field})));
      stats.records++;
    }
    function remove(owner, objectId) {
      const key = owner + "/" + objectId, known = owned.get(owner), matches = targets.get(objectId);
      known?.delete(objectId);
      if (known && !known.size) owned.delete(owner);
      matches?.delete(owner);
      if (matches && !matches.size) targets.delete(objectId);
      replaceEdges(key, []);
      stats.records++;
    }
    function clear(owner) {
      for (const objectId of owned.get(owner) ?? []) remove(owner, objectId);
    }
    function relation(record, recordId = record?.id) {
      const key = "link/" + recordId;
      if (!validRecord(record)) return replaceEdges(key, []);
      replaceEdges(key, [{key, source:{...record.source}, target:{...record.target}, label:record.label, recordId}]);
      stats.records++;
    }
    function external(owner, source, references) {
      const key = "external/" + owner, seen = new Map();
      for (const entry of references) if (address(entry.target)) seen.set(targetKey(entry.target), entry);
      if (seen.size) externals.set(owner, {source, references:[...seen.values()]});
      else externals.delete(owner);
      replaceEdges(key, [...seen].map(([name, entry]) => ({key:key + "/" + name, source:{...source}, target:{...entry.target}, field:entry.field})));
      stats.records++;
    }
    function anchor(anchor, anchorId = anchor?.id) {
      if (validAnchor(anchor)) pinned.set(anchorId, {...anchor});
      else pinned.delete(anchorId);
    }
    function clearRelations(key) {
      for (const owner of outgoing.keys()) if (owner.startsWith(key + "/")) replaceEdges(owner, []);
    }
    function backlinkPage(target, {offset = 0, limit = Infinity, excludeCommits = false} = {}) {
      const rows = [];
      for (const edge of incoming.get(bucket(target))?.values() ?? []) {
        if ((!target.fragment || edge.target.fragment === target.fragment) && (!excludeCommits || edge.source.kind !== "commit")) rows.push(edge);
      }
      const total = rows.length;
      if (!limit || offset >= total) return {total, rows:[]};
      rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      return {total, rows:rows.slice(offset, offset + limit).map(({key, ...edge}) => copy(edge))};
    }
    return Object.freeze({
      projectId, put, remove, clear, clearRelations, relation, external, anchor,
      externalRows:() => externals.entries(),
      importCommits(commits, {replace = false} = {}) {
        if (replace) for (const [owner, {source}] of externals) if (owner.startsWith("git/")) external(owner, source, []);
        gitReferences({external}, commits);
      },
      anchors:() => pinned.values(), anchorOf:key => pinned.get(key),
      locations:objectId => locationsOf(targets, objectId),
      uniqueOwner(objectId) {
        const matches = targets.get(objectId);
        if (matches?.size === 1) return matches.keys().next().value;
      },
      matchesDocuments(project) {
        const known = owned.get("documents"), documents = list(project.documents);
        return (known?.size ?? 0) === documents.length && documents.every(doc =>
          known.has(doc.id) && (owned.get(doc.id)?.size ?? 0) === list(doc.items).length);
      },
      backlinkPage, backlinks:target => backlinkPage(target).rows,
      stats:() => ({...stats})
    });
  }
  const copy = value => JSON.parse(JSON.stringify(value));
  const revisions = project => [...new Map([...list(project.releaseDescriptors), ...list(project.revisions)]
    .map(record => [record.id, record])).values()];
  const projectCollections = [
    ["rules", "rule", p => list(p.rules?.list)],
    ["signals", "signal", p => list(p.signals?.signals)],
    ["review", "comment", p => entries(p.review?.records)],
    ["revisions", "revision", revisions],
    ["library", "library", p => list(p.library)],
    ["layoutBlocks", "block", p => list(p.layoutBlocks)],
    ["savedViews", "savedView", p => list(p.savedViews)],
    ["savedQueries", "savedQuery", p => list(p.savedQueries)],
    ["slides", "slide", p => list(p.slides)],
    ["datasheets", "datasheet", p => entries(p.datasheets)]
  ];
  const labelOf = record => record.ref || record.name || record.title || record.letter || record.text || record.net;
  const itemKind = item => G.Atrium?.notebookItemKind?.(item) ?? item.kind;
  const projectRow = project => ({owner:"project", objectId:project.id, kind:"project", label:project.name});
  const documentRow = doc => ({owner:"documents", objectId:doc.id, documentId:doc.id, kind:doc.kind, label:doc.name});
  function itemRow(doc, item) {
    const point = Number.isFinite(item.x) && Number.isFinite(item.y) ? [item.x, item.y] : item.at;
    return {owner:doc.id, objectId:item.id, documentId:doc.id, kind:itemKind(item), label:labelOf(item), record:item,
      point:Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) ? point : undefined, net:item.net};
  }
  function addItem(index, doc, item) {
    index.put(itemRow(doc, item));
  }
  function addDocument(index, doc, matches) {
    if (!matches || matches(doc.id)) index.put(documentRow(doc));
    for (const item of list(doc.items)) if (!matches || matches(item.id)) addItem(index, doc, item);
  }
  function addMetadata(index, project, key, matches) {
    const collection = projectCollections.find(([slot]) => slot === key);
    if (!collection) return;
    const [, kind, values] = collection;
    if (!matches) index.clear(key);
    for (const record of values(project)) if (!matches || matches(record.id)) addMeta(index, project, key, kind, record);
  }
  function addMeta(index, project, key, kind, record) {
    const documentId = record.documentId ?? record.doc ?? record.scope?.documentId ?? record.source?.documentId ??
      project.review?.records?.[record.thread]?.doc;
    index.put({owner:key, objectId:record.id, kind, label:labelOf(record), documentId, record, point:record.anchor?.at});
  }
  function addTargets(index, project, matches) {
    if (!matches || matches(project.id)) index.put(projectRow(project));
    for (const doc of list(project.documents)) addDocument(index, doc, matches);
    for (const [key] of projectCollections) addMetadata(index, project, key, matches);
  }
  function fromProject(project, previous) {
    const index = createIndex(project.id);
    addTargets(index, project);
    for (const record of entries(project.links)) index.relation(record);
    for (const value of entries(project.linkAnchors)) index.anchor(value);
    if (previous?.projectId === project.id) for (const [owner, {source, references}] of previous.externalRows()) {
      index.external(owner, source, references);
    }
    return index;
  }

  // A point lookup scans IDs to detect collisions across owners. It only reads
  // matching locations and their anchors, so it doesn't build an edge graph or
  // hold onto a mutable project's object identities between invocations.
  function lookup(project, objectIds) {
    const wanted = new Set(objectIds), targets = new Map(), anchors = new Map();
    for (const anchor of entries(project.linkAnchors)) if (wanted.has(anchor?.id) && validAnchor(anchor)) anchors.set(anchor.id, anchor);
    for (const anchor of anchors.values()) wanted.add(anchor.ownerId);
    const matches = wanted.size === 1 ? id => id === objectIds[0] : id => wanted.has(id);
    addTargets({put:row => putLocation(targets, row)}, project, matches);
    return {projectId:project.id, locations:objectId => locationsOf(targets, objectId), anchorOf:objectId => anchors.get(objectId)};
  }

  function update(index, project, records, direction = 1) {
    // The undo journal carries exact changed records in both directions, even if a
    // transient drag has since changed the live editor object's coordinates.
    if (!index || index.projectId !== project.id || records.some(row => row.t === "r")) return fromProject(project, index);
    const changedMaps = new Set(), changedMetadata = new Set();
    const updateMap = (key, value, id) => {
      if (key === "links") index.relation(value, id);
      else index.anchor(value, id);
    };
    const decode=value=>{
      const snapshot=G.AtriumUndoStore?.tableItemSnapshot?.(value);
      return typeof value==="string"?JSON.parse(value):snapshot?JSON.parse(snapshot.tableJSON()):value;
    };
    function updateRecord(row, put, remove) {
      if (row.t === "e") {
        if(row.cellOffset!==undefined)return; // A cell delta leaves this item's link location and indexed fields unchanged.
        const before = decode(direction > 0 ? row.before : row.after), after = decode(direction > 0 ? row.after : row.before);
        if (before.id !== after.id) remove(before.id);
        put(after);
      } else if (row.t === "s") {
        const [removed, inserted] = direction > 0 ? [row.removed, row.inserted] : [row.inserted, row.removed];
        for (const [, value] of removed) remove(value.id);
        for (const [, value, saved] of inserted) put(decode(saved) ?? value);
      }
    }
    for (const row of direction > 0 ? records : [...records].reverse()) {
      const {node, key} = row, path = node.path;
      const doc = node.doc?.ref;
      if (node.t === "l") {
        updateRecord(row, add => addDocument(index, add.ref ?? add), remove => {
          index.clear(remove); index.remove("documents", remove);
        });
      } else if (doc) {
        if (path === "items") updateRecord(row, add => addItem(index, doc, add), remove => index.remove(doc.id, remove));
        else if (path === "" && key === "items") {
          index.clear(doc.id);
          for (const item of doc.items) addItem(index, doc, item);
        } else if (path === "" && key === "name") {
          index.put(documentRow(doc));
        }
      } else if (path === "links" || path === "linkAnchors") {
        updateMap(path, project[path]?.[key], key);
      } else if (path === "" && (key === "links" || key === "linkAnchors")) {
        changedMaps.add(key);
      } else if (path === "" && key === "name") {
        index.put(projectRow(project));
      } else {
        const rawSlot = path.split(".")[0] || key;
        const slot = rawSlot === "releaseDescriptors" ? "revisions" : rawSlot;
        const collection = projectCollections.find(([name]) => name === slot);
        if (!collection) continue;
        const [, kind] = collection;
        const arrayPath = {rules:"rules.list", signals:"signals.signals"}[slot] ?? slot;
        if (path === arrayPath && (row.t === "s" || row.t === "e")) {
          updateRecord(row, add => addMeta(index, project, slot, kind, add), remove => index.remove(slot, remove));
        } else if (path === "review.records" && id(key)) {
          const comment = project.review?.records?.[key];
          if (comment) addMeta(index, project, slot, kind, comment);
          else index.remove(slot, key);
        } else changedMetadata.add(slot);
      }
    }
    for (const key of changedMetadata) addMetadata(index, project, key);
    for (const key of changedMaps) {
      if (key === "links") index.clearRelations("link");
      else for (const row of index.anchors()) index.anchor(null, row.id);
      for (const value of entries(project[key])) updateMap(key, value, value.id);
    }
    return index;
  }

  function netAt(project, doc, item) {
    const named = item.net ?? (item.kind === "netlabel" ? item.text : undefined);
    if (typeof named === "string" && named) return named;
    if (doc.kind !== "schematic" || item.kind !== "wire") return null;
    const defs = new Map(list(project.library).map(definition => [definition.id, definition]));
    return G.Atrium?.connectivity?.(doc, defs).byWire.get(item.id) ?? null;
  }
  function pinIdentity(pin, definitionId) {
    return pin.nativeIdOwner && pin.nativeIdOwner !== definitionId ? undefined : pin.nativeId;
  }

  function locateAnchor(index, project, anchor) {
    const locations = index.locations(anchor.ownerId).filter(row => row.documentId);
    if (locations.length !== 1) return locations.length ? {status:"ambiguous", candidates:locations.map(copy)} : {status:"missing-object"};
    const [location] = locations, doc = list(project.documents).find(row => row.id === location.documentId);
    const owner = doc?.items.find(row => row.id === anchor.ownerId);
    if (!owner) return {status:"missing-object"};
    let label, point, net;
    if (anchor.kind === "pin") {
      const def = list(project.library).find(row => row.id === owner.def);
      const terminals = G.Atrium?.pins?.(owner, def, doc.kind) ?? [];
      const pins = terminals.filter(pin => anchor.terminalId ? (pinIdentity(pin, def?.id) === anchor.terminalId || pin.id === anchor.terminalId) :
        pin.number === anchor.terminal);
      if (pins.length !== 1) return {status:pins.length ? "ambiguous" : "missing-object"};
      const [pin] = pins;
      label = (owner.ref || "Component") + " · " + (pin.name || pin.number);
      point = pin.at;
    } else {
      net = netAt(project, doc, owner);
      if (typeof net !== "string" || !net) return {status:"missing-object"};
      label = net;
      point = location.point;
    }
    return {status:"found", target:{projectId:project.id, objectId:anchor.id, documentId:doc.id, kind:anchor.kind,
      label, presentedId:owner.id, ...(point && {point:[...point]}), ...(net && {net})}};
  }
  function resolve(project, target, index, {complete = true} = {}) {
    if (typeof target === "string") target = parse(target);
    if (!address(target)) return {status:"invalid-link"};
    if (project?.id !== target.projectId) return {status:"missing-project", projectId:target.projectId};
    if (index?.projectId !== project.id) index = lookup(project, [target.objectId]);
    const {objectId, fragment} = target;
    const candidates = index.locations(objectId);
    const anchor = index.anchorOf(objectId);
    if (candidates.length + Number(!!anchor) > 1) return {status:"ambiguous", candidates:candidates.map(copy)};
    if (!complete) return {status:"partial", objectId, candidates:candidates.map(copy)};
    if (anchor) return fragment ? {status:"missing-fragment"} : locateAnchor(index, project, anchor);
    if (fragment) {
      const page = Number(fragmentPattern.exec(fragment)[1]);
      const located = G.AtriumDatasheetRecord?.resolveFragment?.(project, {projectId:project.id, objectId}, {page});
      if (!located) return {status:candidates.length ? "missing-fragment" : "missing-object", objectId};
      return {status:"found", target:{...copy(candidates[0] ?? {kind:"datasheet"}), ...copy(located), projectId:project.id, objectId, fragment}};
    }
    if (!candidates.length) return {status:"missing-object", objectId};
    return {status:"found", target:{...copy(candidates[0]), projectId:project.id}};
  }
  function resolveTargets(project, targets, options) {
    if (targets.length === 1) return [resolve(project, targets[0], undefined, options)];
    const parsed = targets.map(target => typeof target === "string" ? parse(target) : target);
    const localIds = parsed.filter(target => address(target) && target.projectId === project?.id).map(target => target.objectId);
    const index = localIds.length ? lookup(project, localIds) : undefined;
    return parsed.map(target => resolve(project, target, index, options));
  }
  // The caller verifies that this graph still owns the current editor revision.
  // Its unique owner narrows the search, and the live row supplies the projection.
  function resolveFromOwner(project, target, index) {
    if (!address(target) || project.id !== target.projectId || target.fragment || index.anchorOf(target.objectId)) return null;
    const {objectId} = target, owner = index.uniqueOwner(objectId);
    let row;
    if (owner === "project") row = projectRow(project);
    else if (owner === "documents") {
      const doc = list(project.documents).findLast(entry => entry.id === objectId && entry.kind);
      if (doc) row = documentRow(doc);
    } else if (id(owner)) {
      const doc = list(project.documents).findLast(entry => entry.id === owner);
      const item = list(doc?.items).findLast(entry => entry.id === objectId && itemKind(entry));
      if (item) row = itemRow(doc, item);
    }
    const location = row && locationOf(row);
    return location ? {status:"found", target:{...copy(location), projectId:project.id}} : null;
  }
  function anchorPlan(project, args) {
    const {documentId, ownerId, kind, terminal} = args;
    const doc = list(project?.documents).find(row => row.id === documentId);
    const item = doc?.items.find(row => row.id === ownerId);
    if (!item || !id(documentId) || !id(ownerId)) return {status:"missing-object"};
    let terminalId, embeddedId;
    if (kind === "pin") {
      const def = list(project.library).find(row => row.id === item.def);
      const pins = G.Atrium?.pins?.(item, def, doc.kind)?.filter(pin => pin.number === terminal) ?? [];
      if (pins.length !== 1) return {status:pins.length ? "ambiguous" : "missing-object"};
      embeddedId = id(pins[0].id) ? pins[0].id : undefined;
      const nativeId = pinIdentity(pins[0], def?.id);
      terminalId = R.terminalIdentity(nativeId) ? nativeId : embeddedId;
    } else if (kind !== "net" || !netAt(project, doc, item)) return {status:"missing-object"};
    const existing = entries(project.linkAnchors).filter(row => row.ownerId === ownerId && row.kind === kind &&
      (kind === "net" || (terminalId ? row.terminalId != null && (row.terminalId === terminalId || row.terminalId === embeddedId) :
        !row.terminalId && row.terminal === terminal)));
    if (existing.length > 1) return {status:"ambiguous"};
    const anchor = existing[0] ?? {id:G.AtriumUUID.next(), kind, documentId, ownerId,
      ...(kind === "pin" && {terminal}), ...(terminalId && {terminalId})};
    if (!validAnchor(anchor)) return {status:"invalid-link"};
    return {status:"found", anchor, created:!existing.length, url:format({projectId:project.id, objectId:anchor.id})};
  }

  function gitReferences(index, commits) {
    for (const commit of commits) {
      const id = commit.revision ?? commit.id;
      if (typeof id !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)) continue;
      const targets = Array.isArray(commit.recordLinks) ? commit.recordLinks.map(parse).filter(Boolean) : extract(commit.message ?? commit.subject);
      index.external("git/" + id, {kind:"commit", commitId:id, label:shortLabel(commit.subject)},
        targets.map(target => ({target, field:"message"})));
    }
  }
  return Object.freeze({parse, format, extract, address, validSource, validRecord, validAnchor, authoredRecord, createIndex,
    fromProject, addDocument, addItem, addMetadata, update, resolve, resolveTargets, resolveFromOwner, gitReferences, anchorPlan});
})();
