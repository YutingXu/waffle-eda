"use strict";
// Physical projection for the design query compiler. Rule subjects can pass the
// exact features they already use for clearance. Board scans resolve the same
// geometry lazily by owner and retain it across committed local changes.
globalThis.AtriumDesignQueryGeometry = (() => {
  const K = () => globalThis.AtriumRules?.kit;
  const contexts = new WeakMap(), noDefinitions = new Map(), noAliases = Object.freeze([]);
  const finitePoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  const finiteBox = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[0] <= b[2] && b[1] <= b[3];
  const isFeature = f => finiteBox(f?.box) && f?.core?.length > 0 && f?.edges?.length > 0 && Number.isFinite(f?.radius);
  const ownerId = ref => ref?.ownerId ?? ref?.objectId ?? ref?.itemId ?? ref?.part?.id ?? ref?.parent?.id ?? ref?.id;
  const documentId = ref => ref?.documentId ?? ref?.docId;
  const instanceId = ref => ref?.occurrenceId ?? ref?.instanceId;
  function aliasesFor(item) {
    const {id, ref, name} = item, hasRef = typeof ref === "string" && ref && ref !== id;
    const hasName = typeof name === "string" && name && name !== id && name !== ref;
    if (hasRef && hasName) return [ref, name];
    if (hasRef || hasName) return [hasRef ? ref : name];
    return noAliases;
  }
  const union = (a, b) => a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b.slice();
  const featureBounds = fs => fs.reduce((b, f) => union(b, f.box), null);
  const spatialBounds = (box, radius) => {
    // Cover the compiler's binary64 relative comparison at the broad-phase edge.
    // The exact distance below has no query tolerance.
    const reach = radius + radius * 2e-12 + Number.EPSILON * Math.max(...box.map(Math.abs), radius);
    const bounds = [box[0] - reach, box[1] - reach, box[2] + reach, box[3] + reach];
    return finiteBox(bounds) ? bounds : undefined;
  };

  function create({doc, defs, lookup, searchOwners, journal, revision, definitionSource, projectId, occurrence, canRead, allows} = {}) {
    const projected = new Map(), definitions = new Map();
    const currentDefs = () => (typeof defs === "function" ? defs() : defs) || noDefinitions;
    let owners, names, frame, index, stackKeys = {};

    function sync() {
      if (!doc || doc.kind !== "pcb" || !K() || canRead?.() === false) return null;
      const store = typeof journal === "function" ? journal() : journal;
      if (store?.unrecorded?.()) return null;
      const token = typeof revision === "function" ? revision() : revision;
      const state = store?.documentVersions?.(doc, undefined, true);
      const cold = !state && token != null ? store?.verifiedDocumentVersion?.(doc) : undefined;
      if (store?.documentVersions && !state && cold == null) return null;
      const current = {items:doc.items, count:doc.items.length, revision:token, defs:definitionSource?.(), state, store, cold};
      const previous = frame?.state, next = current.state;
      const sameSource = frame && current.items === frame.items && current.defs === frame.defs && store === frame.store && cold === frame.cold;
      const sameLayers = (!stackKeys.pad && !stackKeys.via) || previous?.pours === next?.pours;
      if (sameSource && current.count === frame.count && current.revision === frame.revision &&
          previous?.seq === next?.seq && previous?.floor === next?.floor && previous?.outer === next?.outer &&
          previous?.library === next?.library && sameLayers) return frame;
      const changes = sameSource && sameLayers && previous && next && previous.outer === next.outer && previous.library === next.library &&
        store.recordedChanges(doc, previous.seq);
      const sameStack = !changes?.ids?.size || (!stackKeys.pad && !stackKeys.via) ||
        store.onlyRecordedItemUpdates?.(doc, previous.seq, (a, b) => a.layer === b.layer && a.fromLayer === b.fromLayer &&
          a.toLayer === b.toLayer && a.def === b.def);
      if (changes?.ids && sameStack) {
        for (const id of changes.ids) {
          projected.delete(id);
          if (owners) {
            removeOwner(id);
            if (changes.items.has(id)) addOwner(changes.items.get(id));
          }
        }
      } else {
        projected.clear(); definitions.clear(); stackKeys = {};
        owners = names = index = undefined;
      }
      return frame = current;
    }

    function inScope(ref) {
      return !!ref && (documentId(ref) == null || documentId(ref) === doc.id) &&
        (instanceId(ref) == null || instanceId(ref) === occurrence) &&
        (ref.projectId == null || projectId == null || ref.projectId === projectId) && (!allows || allows(ref));
    }

    function addOwner(item) {
      if (typeof item.id !== "string" || !inScope({id:item.id, docId:doc.id, occurrenceId:occurrence})) return;
      const keys = aliasesFor(item);
      owners.set(item.id, {item, keys});
      for (const name of keys) {
        if (!names.has(name)) names.set(name, new Set());
        names.get(name).add(item.id);
      }
      if (index) index.grid.insert(item, 0);
    }

    function removeOwner(id) {
      const old = owners.get(id);
      if (!old) return;
      index?.grid.remove(old.item);
      index?.unmeasured.delete(id);
      for (const name of old.keys) {
        const matches = names.get(name);
        matches.delete(id);
        if (!matches.size) names.delete(name);
      }
      owners.delete(id);
    }

    function ensureOwners() {
      if (owners) return;
      owners = new Map(); names = new Map();
      for (const item of doc.items) addOwner(item);
    }

    function itemFor(ref) {
      if (!inScope(ref)) return null;
      const id = ownerId(ref);
      if (id == null) return null;
      if (lookup) return lookup(id) || null;
      ensureOwners();
      return owners.get(id)?.item || null;
    }

    function resolveRef({family, binding, name, span}) {
      if (family !== "anchor") return undefined;
      const issue = (code, message) => ({diagnostic:{code, message, span}});
      const unavailable = () => issue("broken-reference", "The nearby anchor is unavailable in this view.");
      if (!sync()) return unavailable();
      const saved = binding?.target;
      let item;
      if (binding) {
        if (!saved || saved.detached || saved.needsRebind) return unavailable();
        item = itemFor(saved);
      } else {
        ensureOwners();
        item = owners.get(name)?.item;
        if (item && !inScope({id:item.id, docId:doc.id, occurrenceId:occurrence})) item = undefined;
        for (const id of names.get(name) || []) {
          if (!inScope({id, docId:doc.id, occurrenceId:occurrence})) continue;
          if (item) return issue("ambiguous-reference", "Choose a unique object for the nearby anchor.");
          item = owners.get(id)?.item;
        }
      }
      return item ? {target:{...saved, id:item.id, docId:doc.id, occurrenceId:occurrence, name:item.ref || item.name || name}} : unavailable();
    }

    function partExtent(item) {
      const D = globalThis.AtriumDFA;
      const def = currentDefs()?.get(item.def);
      if (!D || !def?.footprint) return null;
      // DFA caches its outline by definition identity. Use a fresh identity when
      // the definition journal advances, including an in-place library edit.
      if (!definitions.has(def)) definitions.set(def, new Map([[item.def, {...def}]]));
      const map = definitions.get(def), evidence = D.outlineEvidence(map.get(item.def));
      const hasCourt = evidence.courtyardSource === "courtyard" || evidence.courtyardSource === "courtyard-shapes";
      const basis = hasCourt ? evidence.courtyardSource : evidence.bodySource;
      if (!basis) return null;
      const record = D.record(item, map, {measure:hasCourt ? "courtyard" : "body"});
      if (!record?.poly.every(finitePoint) || !finiteBox(record.box)) return null;
      return {basis, features:[K().feature({}, record.poly, 0)]};
    }

    function projection(item) {
      let value = projected.get(item.id);
      if (value?.item !== item) {
        value = {item};
        projected.set(item.id, value);
      }
      return value;
    }

    function boundary(rings, basis) {
      const features = [];
      for (const ring of rings) {
        if (!Array.isArray(ring) || ring.length < 3 || !ring.every(finitePoint)) return null;
        for (let i = 0; i < ring.length; i++) features.push(K().feature({}, [ring[i], ring[(i + 1) % ring.length]], 0));
      }
      return features.length ? {basis, features} : null;
    }

    function boardBoundary(ref) {
      if (ownerId(ref) !== doc.id || !inScope(ref)) return null;
      const holes = globalThis.AtriumBoardShape?.holes(doc) || [];
      if (ref.kind === "cutout") return boundary(holes, "board-cutouts");
      if (ref.kind === "board-edge") return boundary([doc.outline, ...holes], "board-edge");
      return null;
    }

    function copperFor(record) {
      return record.copper ??= K().extract(doc, currentDefs(), {items:[record.item], physical:true, planeHoles:true, stackKeys});
    }

    function boundsFor(item, unmeasured) {
      const existing = projected.get(item.id);
      const record = existing?.item === item ? existing : {item};
      const geo = copperFor(record);
      if (item.kind === "part" && record.part === undefined) record.part = partExtent(item);
      const holes = geo.holes.map(f => f.planeHole || f);
      if (item.cutout && record.cutout === undefined) record.cutout = boundary([item.points], "cutout");
      const all = [...geo.copper, ...holes, ...(record.part?.features || []), ...(record.cutout?.features || [])];
      const valid = all.filter(isFeature);
      if (!valid.length || valid.length !== all.length || geo.excluded || item.kind === "part" && !record.part) unmeasured.add(item.id);
      return featureBounds(valid);
    }

    function emptyIndex() {
      const unmeasured = new Set();
      const grid = globalThis.AtriumSpatial.create([], item => boundsFor(item, unmeasured));
      return {grid, unmeasured};
    }

    async function prepareSpatial({signal, isCurrent} = {}) {
      if (signal?.aborted || isCurrent?.() === false) return false;
      const snapshot = sync(), current = () => !signal?.aborted && isCurrent?.() !== false && snapshot === sync();
      if (!snapshot) return false;
      if (index || searchOwners || !globalThis.AtriumSpatial) return true;
      ensureOwners();
      const pending = emptyIndex(), now = () => globalThis.performance?.now?.() ?? Date.now();
      let until = now() + 4, i = 0;
      for (const {item} of owners.values()) {
        pending.grid.insert(item, i++);
        if ((i & 31) === 0 && now() >= until && typeof setTimeout === "function") {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (!current()) return false;
          if (index) return true;
          until = now() + 4;
        }
      }
      if (!current()) return false;
      index = pending;
      return true;
    }

    function spatial(bounds) {
      if (!finiteBox(bounds) || !sync()) return undefined;
      // A caller can lend its maintained index when its bounds cover physical
      // bodies, courtyard and every land. Headless contexts build once on demand.
      if (searchOwners) {
        const candidates = searchOwners(bounds);
        return candidates == null ? undefined : Array.from(candidates, x => typeof x === "string" ? x : ownerId(x))
          .filter(id => id != null && inScope({id, docId:doc.id, occurrenceId:occurrence}));
      }
      if (!globalThis.AtriumSpatial) return undefined;
      if (!index) {
        ensureOwners();
        index = emptyIndex();
        for (const {item} of owners.values()) index.grid.insert(item, 0);
      }
      const ids = new Set(index.grid.query(bounds).map(item => item.id));
      for (const id of index.unmeasured) ids.add(id);
      return [...ids].filter(id => inScope({id, docId:doc.id, occurrenceId:occurrence}));
    }

    function physical(item, subject) {
      const record = projection(item), kind = subject.kind ?? item.kind;
      if (item.cutout) {
        if (record.cutout === undefined) record.cutout = boundary([item.points], "cutout");
        return record.cutout;
      }
      if (item.kind === "part" && kind !== "pad" && kind !== "hole" && subject.pin == null && subject.ck !== "hole") {
        if (record.part === undefined) record.part = partExtent(item);
        return record.part;
      }
      const geo = copperFor(record);
      let features;
      if (subject.ck === "hole" || kind === "hole") features = geo.holes.map(f => f.planeHole ? {...f, ...f.planeHole} : f);
      else if (kind === "pad") features = geo.pads.filter(f => !f.maskOnly);
      else features = geo.copper;
      const terminal = subject.sub ? subject.item || subject : subject;
      const pin = subject.pin ?? terminal.pin, slot = subject.padIndex ?? terminal.padIndex;
      const padId = subject.padId ?? terminal.padId ?? (!subject.sub && item.kind === "part" && kind === "pad" ? subject.item?.id : undefined);
      if (pin != null || padId != null || slot != null) features = features.filter(f =>
        (pin == null || f.pin === String(pin)) && (padId == null || f.item?.id === padId) && (slot == null || f.padIndex === slot));
      const surface = subject.layer ?? terminal.layer;
      if (surface && surface !== "Multi") {
        const layer = K().copperIndex(surface);
        if (layer !== null) features = features.filter(f => f.span && f.span[0] <= layer && f.span[1] >= layer);
      }
      return features.length && features.every(isFeature) ? {basis:"clearance", features} : null;
    }

    function resolveAnchor(target, mode) {
      if (mode === "body" && ownerId(target) === doc.id && (target.kind === "board-edge" || target.kind === "cutout")) {
        const value = boardBoundary(target);
        return value && {...value, item:doc};
      }
      const item = itemFor(target);
      if (!item) return null;
      if (mode === "origin") {
        if (item.kind !== "part" || !finitePoint([item.x, item.y])) return null;
        return {item, basis:"placement-origin", features:[K().feature({}, [[item.x, item.y]], 0)]};
      }
      if (mode !== "body") return null;
      const value = physical(item, {...target, kind:item.kind});
      return value && {...value, item};
    }

    function distance(subject, anchor) {
      if (!anchor || !inScope(subject)) return null;
      const boardSide = (subject.kind === "board-edge" || subject.kind === "cutout") && boardBoundary(subject);
      const exact = isFeature(subject), item = exact || boardSide ? null : itemFor(subject);
      const from = exact ? [subject] : boardSide?.features || item && physical(item, subject)?.features;
      if (!from?.length) return null;
      let least = Infinity;
      for (const a of from) for (const b of anchor.features) {
        least = Math.min(least, K().pieceGap(a, b, Infinity).d);
        if (!least) return 0;
      }
      return Number.isFinite(least) ? least : null;
    }

    function distanceMm(subject, target, mode = "body") {
      return sync() ? distance(subject, resolveAnchor(target, mode)) : null;
    }

    function prepareNear({anchor:target, mode = "body", radius}) {
      const snapshot = sync();
      const anchor = snapshot && resolveAnchor(target, mode);
      if (!anchor) return {ok:false, diagnostic:{code:"geometry", message:"The bound object has no available geometry in this view."}};
      if (!Number.isFinite(radius) || radius < 0)
        return {ok:false, diagnostic:{code:"geometry", message:"A nearby distance must be finite and nonnegative."}};
      const raw = featureBounds(anchor.features);
      return {ok:true, bounds:spatialBounds(raw, radius), basis:anchor.basis,
        dependencies:["item:" + doc.id + "/" + anchor.item.id, ...(anchor.item.def ? ["definition:" + anchor.item.def] : [])],
        matches(subject) {
          const d = sync() === snapshot ? distance(subject, anchor) : null;
          return d == null ? null : d <= radius || d - radius <= 1e-12 * Math.max(d, radius);
        }};
    }

    return Object.freeze({distanceMm, prepareNear, resolveRef, prepareSpatial, spatial});
  }

  function context(project, doc, opts = {}) {
    if (!project || doc?.kind !== "pcb") return undefined;
    const {authority, store, defs:explicitDefs, getRevision:readRevision, revision, allows, lookup, searchOwners} = opts;
    const occurrence = opts.instanceId ?? opts.occurrenceId;
    const canRead = () => !authority || !authority.revoked && authority.readProject !== false &&
      (!authority.projectId || authority.projectId === project.id) && (!authority.canReadDocument || authority.canReadDocument(doc.id)) &&
      (!authority.documentIds || (authority.documentIds.has?.(doc.id) ?? authority.documentIds.includes(doc.id)));
    const getStore = () => store || (globalThis.AtriumUndoStore?.root?.() === project ? globalThis.AtriumUndoStore : undefined);
    const getRevision = () => readRevision?.() ?? (typeof revision === "function" ? revision() : revision);
    const definitionSource = () => explicitDefs || project.library;
    let entry, partition;
    if (!allows && !lookup && !searchOwners && canRead()) {
      let byDocument = contexts.get(project);
      if (!byDocument) contexts.set(project, byDocument = new WeakMap());
      let cache = byDocument.get(doc);
      if (!cache) byDocument.set(doc, cache = {open:new Map(), restricted:new WeakMap()});
      partition = authority ? cache.restricted.get(authority) : cache.open;
      if (!partition) cache.restricted.set(authority, partition = new Map());
      entry = partition.get(occurrence);
      if (entry && entry.store === store && entry.explicitDefs === explicitDefs && entry.readRevision === readRevision) {
        entry.revision = getRevision;
        return entry.geometry;
      }
    }
    entry = {store, explicitDefs, readRevision, revision:getRevision};
    let source, version, definitions;
    const defs = () => {
      if (explicitDefs) return explicitDefs;
      const list = project.library, v = getStore()?.libraryVersion?.() ?? entry.revision();
      if (!definitions || source !== list || version !== v) {
        source = list; version = v;
        definitions = new Map((list || []).map(d => [d.id, d]));
      }
      return definitions;
    };
    entry.geometry = create({doc, defs, definitionSource, projectId:project.id, occurrence, journal:getStore,
      revision:() => entry.revision(), canRead, allows, lookup, searchOwners});
    if (partition && partition.size >= 8 && !partition.has(occurrence)) partition.delete(partition.keys().next().value);
    partition?.set(occurrence, entry);
    return entry.geometry;
  }

  return Object.freeze({create, context});
})();
