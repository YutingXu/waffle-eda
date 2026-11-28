"use strict";

// The editor, workers and detached output jobs resolve the same authored owners.
// View state (camera, visible layers, selection and render preferences) stays outside this module.
globalThis.AtriumResolvedGeometry = (() => {
  const G = globalThis, bindings = new WeakMap(), views = new WeakMap(), lineage = new WeakMap();
  const historyLimit = 24;
  let generation = 0;
  const filmFields = ["maskExpansion", "pasteExpansion", "overrideExpansions", "tentVias", "tentTop", "tentBottom"];
  const module = name => {
    const api = G[name];
    if (!api) throw Error(name + " is required to resolve board geometry");
    return api;
  };
  const curves = () => module("AtriumGeometryCurves");
  const material = () => module("AtriumGeometryMaterial");
  const clone = value => G.Atrium.clone(value);
  const immutable = value => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      for (const child of Array.isArray(value) ? value : Object.values(value)) immutable(child);
      Object.freeze(value);
    }
    return value;
  };
  const ownerKey = key => JSON.stringify([key.documentId, key.instancePath, key.kind, key.kind === "item" ? key.id : null]);
  const featureKey = key => JSON.stringify([key.member, key.role, key.layer]);
  const occurrenceKey = occurrence => JSON.stringify([occurrence.documentId, occurrence.instancePath]);
  const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  const sameFeature = (a, b) => a.layer === b.layer && a.role === b.role && same(a.member, b.member);
  const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
  const boxOf = () => [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (b, f) => [b[0] - f, b[1] - f, b[2] + f, b[3] + f];
  const toLines = (points, close = false) => curves().lineEdges(close && points.length > 2 &&
    (points[0][0] !== points.at(-1)[0] || points[0][1] !== points.at(-1)[1]) ? [...points, points[0]] : points);
  const exactLoop = edges => edges.map(edge => edge.kind === "arc" ? curves().arcEdge(edge) : edge);
  const region = (outer, holes = []) => ({kind: "region", islands: [{outer, holes}]});
  function mapInk(ink, transform) {
    if (!transform) return ink;
    if (ink.kind === "stroke") return {...ink, centerline: ink.centerline.map(edge => curves().placeEdge(edge, transform))};
    if (ink.kind === "region") return {...ink, islands: curves().placeArea(ink.islands, transform)};
    return {...ink, at: transform.at(ink.at),
      clockwiseDegrees: (transform.mirror ? -ink.clockwiseDegrees : ink.clockwiseDegrees) + transform.turn,
      mirrorLocalX: Boolean(ink.mirrorLocalX) !== Boolean(transform.mirror)};
  }

  function inkBounds(ink) {
    const C = curves(), box = boxOf();
    if (ink.kind === "stroke") {
      for (const edge of ink.centerline) C.edgeBounds(edge, box);
      return grow(box, ink.width / 2);
    }
    const placed = ink.kind === "flash" && C.flashFrame(ink);
    for (const island of ink.kind === "flash" ? ink.aperture : ink.islands)
      for (const edge of island.outer) C.edgeBounds(C.placeEdge(edge, placed), box);
    return box;
  }

  function graphic(ctx, shape, member, transform) {
    const PCB = module("AtriumPCBAppearance"), width = PCB.shapeStrokeWidth(shape);
    const layer = shape.layer || "Top", net = shape.net || null;
    const role = shape.keepout || /^keep-?out/i.test(layer) ? "keepout" :
      /silk|overlay/i.test(layer) ? "legend" : "drawing";
    const polarity = curves().artworkPolarity(shape);
    curves().artworkInk(shape, width, (ink, part) => {
      ctx.emit(part === "outline" ? [...member, "stroke"] : member, role, layer, mapInk(ink, transform), {polarity, net});
    });
  }
  function copperInk(pour) {
    const contours = module("AtriumPCBPours").contourEdges(pour);
    return contours[0]?.length ? region(contours[0], contours.slice(1)) : null;
  }
  function collectInk(ctx, geometry) {
    const {doc, item} = ctx, PCB = module("AtriumPCBAppearance");
    if (!item) {
      if (geometry.copperProblem) ctx.diagnose(["pour"], geometry.copperProblem);
      const S = module("AtriumBoardShape"), shape = S.fresh(doc);
      if (geometry.panelProfile) {
        const {outer, holes, cutouts, segs} = geometry.panelProfile;
        for (const [index, contour] of (segs?.outer || outer.map(points => toLines(points, true))).entries())
          ctx.emit(["profile", String(index)], "profile", "Outline", region(exactLoop(contour)));
        for (const [index, contour] of [...(segs?.holes || holes.map(points => toLines(points, true))), ...cutouts].entries())
          ctx.emit(["cutout", String(index)], "profile", "Outline", region(exactLoop(contour)), {polarity: "clear"});
      } else if (shape) {
        ctx.emit([], "profile", "Outline", region(exactLoop(shape.contour)));
        for (const [index, hole] of [...S.profileCutouts(shape)].entries())
          ctx.emit(["cutout", String(index)], "profile", "Outline", region(exactLoop(hole.contour), hole.cutouts.map(exactLoop)), {polarity: "clear"});
      } else if (doc.outline?.length >= 3) ctx.emit([], "profile", "Outline", region(toLines(doc.outline, true)));
      const copper = geometry.copper;
      if (copper) for (const [index, pour] of copper.regions.entries()) {
        const ink = copperInk(pour);
        if (ink) ctx.emit(["pour", String(index)], "pour", pour.layer, ink, {net: pour.net || null});
      }
      return;
    }
    if (item.kind === "track") {
      const centerline = curves().pathEdges(item);
      if (!centerline.length) return;
      const layer = PCB.boardLayer(item), width = PCB.boardStrokeWidth(item);
      if (width !== null) ctx.emit([], "track", layer, {kind: "stroke", centerline, width}, {net: item.net || null});
      else ctx.diagnose([], "zero-width-track");
      for (const opening of PCB.traceOpenings(item, layer))
        ctx.emit([], opening.layer.endsWith(" mask") ? "mask" : "paste", opening.layer, {kind: "stroke", centerline, width: opening.width});
    } else if (item.kind === "graphic") {
      if (item.dimension) {
        if (item.dimension.export !== false)
          for (const [i, g] of module("AtriumPCBDraw").dimensionPrimitives(item, {units: ctx.project.units}).entries())
            graphic(ctx, g, ["dimension", String(i)]);
      } else graphic(ctx, item, []);
      for (const opening of PCB.traceOpenings(item, item.layer)) {
        const centerline = curves().pathEdges(item);
        if (centerline.length) ctx.emit([], opening.layer.endsWith(" mask") ? "mask" : "paste", opening.layer, {kind: "stroke", centerline, width: opening.width});
      }
    } else if (item.kind === "polygon" && (item.keepout || item.cutout)) {
      if (item.keepout) graphic(ctx, {...item, fill: true}, []);
    } else if (item.kind === "part") {
      const transform = curves().artworkFrame(item);
      const footprint = ctx.defs.get(item.def)?.footprint;
      for (const [index, shape] of (footprint?.shapes || []).entries()) {
        if (shape.kind === "text" || shape.kind === "label") continue;
        graphic(ctx, {...shape, layer: PCB.shapeLayer(item, shape)}, ["artwork", String(index)], transform);
      }
    }
  }

  function bounded(bounds, owner) {
    if (!bounds.every(Number.isFinite)) throw Error("Unbounded physical geometry for " + ownerKey(owner));
    return bounds;
  }
  const noDrilling = immutable({bores: [], diagnostics: []});
  function resolveDrilling(row) {
    if (row.drilling) return row.drilling;
    const {owner, item, geometry} = row;
    if (!["pad", "via", "part"].includes(item?.kind)) return noDrilling;
    const {doc, defs, defaults, layers, transform, boreCopper} = geometry;
    const M = material(), bores = [], diagnostics = [];
    M.collect({doc, defs, item, layers, defaults, copper: boreCopper,
      bore(member, value) {
        let cutter = value.cutter;
        if (transform) cutter = cutter.kind === "round" ? {...cutter, at: transform.at(cutter.at)} :
          {...cutter, centerline: cutter.centerline.map(edge => curves().placeEdge(edge, transform))};
        const bore = {...value, cutter, key: {owner, member: [...member]}};
        if (transform?.mirror) {
          bore.from = transform.layer(value.to);
          bore.to = transform.layer(value.from);
          const roof = geometry.substrateTop;
          bore.z = value.z && roof != null ? [roof - value.z[1], roof - value.z[0]] : null;
          if (value.treatment) {
            const {ipcSides, tented} = value.treatment;
            bore.treatment = {...value.treatment, ipcSides: ipcSides === "top" ? "bottom" : ipcSides === "bottom" ? "top" : ipcSides,
              tented: {top: tented.bottom, bottom: tented.top}};
          }
        }
        if (value.operation === "backdrill") bore.primary = {owner, member: [...value.primary]};
        bores.push({bore, bounds: bounded(M.cutterBounds(bore), owner)});
      },
      diagnose(member, code) { diagnostics.push({owner, member: [...member], code}); }
    });
    return row.drilling = immutable({bores, diagnostics});
  }

  function resolved(row, artworkOnly = false) {
    if (row.result) return artworkOnly ? row.result.value.features : row.result;
    const {owner, item, geometry} = row, {project, doc, defs, defaults, layers, transform, landRules} = geometry;
    const features = [], nominalLands = [], diagnostics = [];
    const boxes = artworkOnly ? null : boxOf(), affected = artworkOnly ? null : new Set();
    const extent = (bounds, layer) => {
      if (!boxes) return;
      boxes[0] = Math.min(boxes[0], bounds[0]); boxes[1] = Math.min(boxes[1], bounds[1]);
      boxes[2] = Math.max(boxes[2], bounds[2]); boxes[3] = Math.max(boxes[3], bounds[3]);
      if (layer) affected.add(layer);
    };
    const ctx = {project, doc, defs, defaults, owner, item, layers, landRules,
      emit(member, role, layer, artwork, {net = null, polarity = "add", text} = {}) {
        const ink = mapInk(artwork, transform), bounds = bounded(inkBounds(ink), owner);
        const key = {owner, member: [...member], role, layer: transform?.layer(layer) ?? layer};
        const feature = {key, ink, net, polarity, bounds};
        if (text) feature.text = transform ? {...text, origin: transform.at(text.origin),
          clockwiseDegrees: transform.angle(text.clockwiseDegrees), mirrored: text.mirrored !== transform.mirror} : text;
        extent(bounds, key.layer);
        features.push(feature);
      },
      nominal(member, ink) {
        const mapped = mapInk(ink, transform);
        extent(bounded(inkBounds(mapped), owner));
        nominalLands.push({member: [...member], ink: mapped});
      },
      diagnose(member, code) { diagnostics.push({owner, member: [...member], code}); }
    };
    collectInk(ctx, geometry);
    // Tracks publish copper and any explicit trace openings together.
    if (!artworkOnly && item?.kind !== "track") {
      module("AtriumMaskOpenings").collect(ctx);
      module("AtriumPCBText").collect(ctx);
    }
    const {bores, diagnostics: drilling} = artworkOnly ? noDrilling : resolveDrilling(row);
    if (bores.length) {
      const M = material();
      for (const {bore, bounds} of bores) {
        extent(bounds);
        for (const layer of layers) if (M.overlapsZ(bore.z, layer.z)) affected.add(layer.name);
      }
    }
    for (const diagnostic of drilling) diagnostics.push(diagnostic);
    // Short rows can validate and find members directly. Large footprints keep an
    // owner-local index to bound validation and repeated area lookups.
    let keys;
    if (features.length > 8) {
      keys = new Map(features.map(feature => [featureKey(feature.key), feature]));
      if (keys.size !== features.length) throw Error("Duplicate resolved feature in " + ownerKey(owner));
    } else {
      for (let i = 1; i < features.length; i++) for (let j = 0; j < i; j++)
        if (sameFeature(features[i].key, features[j].key)) throw Error("Duplicate resolved feature in " + ownerKey(owner));
    }
    if (artworkOnly) return immutable(features);
    const value = immutable({owner, features, bores: bores.map(({bore}) => bore), nominalLands});
    return row.result = {value, keys, bores, diagnostics: immutable(diagnostics),
      bounds: boxes.every(Number.isFinite) ? Object.freeze(boxes) : null, layers: [...affected]};
  }

  function defaultsOf(values = {}) {
    return Object.freeze(Object.fromEntries(filmFields.filter(k => values[k] !== undefined).map(k => [k, values[k]])));
  }
  function stamp(project, doc, sources) {
    const U = G.AtriumUndoStore;
    if (!U) return null;
    const docs = [doc, ...sources.filter(src => src !== doc)];
    const versions = docs.map(d => U.documentVersions(d, project, true) || U.verifiedDocumentVersions(d, project));
    if (versions.some(v => !v)) return null;
    const key = versions.flatMap(v => [v.floor, v.items, v.outer, v.pours, v.project, v.parameters, v.library]);
    return {versions: new Map(docs.map((d, i) => [d, versions[i]])), key};
  }
  function liveDrag(project) {
    const host = G.AtriumNavHost;
    return host?.project?.() === project && !!host.drag?.()?.before;
  }
  function stale() {
    const error = Error("The resolved board geometry revision has expired");
    error.name = "StaleGeometryError";
    error.code = "STALE_GEOMETRY";
    return error;
  }

  function sourceBoard(project, doc, binding, transform, instancePath, panelProfile) {
    const {defs, defaults} = binding, {items, ...metadata} = doc;
    // Detached input is already owned by this binding. Live revisions still
    // copy any data whose source may be changed by a later edit.
    const source = binding.detached ? metadata : clone(metadata);
    const layers = immutable(material().layers(doc, project));
    const substrateTop = layers.find(layer => layer.kind === "dielectric" && layer.z)?.z[1];
    const boreCopper = new Map(layers.filter(layer => layer.kind === "copper").map(layer => [layer.name, layer.z]));
    const copper = binding.outputRegions ? {state:"current", regions:binding.outputRegions} : source.pcbDrawing?.pours?.length ?
      module("AtriumPolygonPour").inspectCopper(doc, defs, {project}) : null;
    return {doc: source, project, defs, defaults, layers, transform, substrateTop, boreCopper,
      landRules: module("AtriumMaskOpenings").rulesForView(doc, project),
      documentId: panelProfile ? binding.root.id : doc.id, instancePath: Object.freeze(instancePath), panelProfile,
      ...currentCopper(copper, binding.detached)};
  }
  function currentCopper(report, owned) {
    if (!report || report.state === "none") return {copper: null, copperProblem: null};
    if (report.state === "current") return {copper: {regions: owned ? report.regions : clone(report.regions)}, copperProblem: null};
    return {copper: null, copperProblem: report.reason || report.state};
  }
  function rowFor(geometry, item, owned = false) {
    const {documentId, instancePath} = geometry;
    const owner = item ? {documentId, instancePath, kind: "item", id: item.id} : {documentId, instancePath, kind: "board"};
    return {owner: Object.freeze(owner), item: item && !owned ? clone(item) : item, geometry, result: null};
  }
  function pathPlan(binding) {
    const {root, project, defs} = binding;
    if (root.kind === "pcb") return [{doc: root, instancePath: []}];
    const panel = module("AtriumPanel").resolvedPlacement(project, root, defs);
    return [{doc: panel.board, realDoc: root, instancePath: [], panelProfile: panel.profile}, ...panel.instances.map(inst => ({
      doc: inst.board, instancePath: inst.instancePath, transform: inst.transform
    }))];
  }
  function snapshotOccurrences(binding, doc) {
    const cached = binding.collisions?.get(doc.id);
    if (cached) return cached.items;
    const original = binding.inputProject.documents.find(source => source.id === doc.id);
    const counts = new Map();
    for (const item of doc.items) counts.set(item.id, (counts.get(item.id) || 0) + 1);
    const used = new Set(counts.keys()), aliases = new WeakMap();
    const items = doc.items.map((item, index) => {
      if (counts.get(item.id) === 1) return item;
      let id = "geometry:" + index + ":" + item.id;
      while (used.has(id)) id += ":";
      used.add(id);
      aliases.set(original.items[index], id);
      return {...item, id};
    });
    binding.collisions ??= new Map();
    binding.collisions.set(doc.id, {items, aliases, counts});
    return items;
  }
  function* orderedRows(groups) {
    for (const group of groups.values()) {
      yield* group.rows.values();
      // Board-derived regions follow explicit authored paths.
      yield group.board;
    }
  }
  function indexRows(groups) {
    const rows = new Map();
    for (const row of orderedRows(groups)) rows.set(ownerKey(row.owner), row);
    return rows;
  }
  function cold(binding, plan) {
    const groups = new Map(), rows = binding.detached ? null : new Map();
    for (const input of plan) {
      const {doc, realDoc = doc, instancePath, transform, panelProfile} = input;
      const geometry = sourceBoard(binding.project, doc, binding, transform, instancePath, panelProfile);
      const board = rowFor(geometry, null), occurrence = occurrenceKey(board.owner);
      const group = {geometry, board, input, doc: realDoc, rows: new Map(), byDefinition: new Map()};
      for (const item of doc.items) {
        if (group.rows.has(item.id)) {
          if (!binding.inputProject) throw Error("A board has duplicate authored item IDs");
          group.rows.clear();
          group.byDefinition.clear();
          for (const localized of snapshotOccurrences(binding, doc)) indexItem(group, rowFor(geometry, localized, true));
          break;
        }
        const row = rowFor(geometry, item, binding.detached);
        indexItem(group, row);
        rows?.set(ownerKey(row.owner), row);
      }
      rows?.set(ownerKey(board.owner), board);
      groups.set(occurrence, group);
    }
    binding.rows = rows;
    binding.groups = groups;
    binding.activePlan = plan;
    binding.layers = immutable([...new Map([...groups.values()].flatMap(g => g.geometry.layers.map(l => [l.name, l]))).values()]);
  }
  function indexItem(group, row) {
    const {item} = row;
    group.rows.set(item.id, row);
    if (item.kind !== "part") return;
    let linked = group.byDefinition.get(item.def);
    if (!linked) group.byDefinition.set(item.def, linked = new Set());
    linked.add(item.id);
  }
  function changedPlacement(doc, old, next) {
    return !old || !next || old.floor !== next.floor || old.outer !== next.outer || old.project !== next.project ||
      (doc.kind === "pcb" && !doc.outline?.length && (old.items !== next.items || old.library !== next.library));
  }
  function samePolygonGeometry(before, after) {
    if (before.kind !== "polygon" || after.kind !== "polygon" ||
        !Object.hasOwn(before, "copperBasis") && !Object.hasOwn(after, "copperBasis")) return false;
    const {copperBasis: oldProof, ...oldGeometry} = before, {copperBasis: newProof, ...newGeometry} = after;
    return oldProof !== newProof && JSON.stringify(oldGeometry) === JSON.stringify(newGeometry);
  }
  function remember(changes, before, after) {
    if (!before && !after) return;
    const key = ownerKey((after || before).owner), previous = changes.get(key);
    changes.set(key, {before: previous ? previous.before : before, after});
  }
  function allRowsChanged(before, after) {
    const changes = new Map();
    for (const key of new Set([...before.keys(), ...after.keys()])) remember(changes, before.get(key), after.get(key));
    return changes;
  }
  function journalChanges(history, index) {
    const changes = new Map();
    for (let k = index; k < history.length; k++)
      for (const {before, after} of history[k].owners.values()) remember(changes, before, after);
    const rows = [], boards = [];
    for (const {before, after} of changes.values()) {
      if (before?.owner.kind === "board" && after?.owner.kind === "board") boards.push([before, after]);
      else { if (before) rows.push(before); if (after) rows.push(after); }
    }
    return dirty(rows, boards);
  }
  function advance(binding, next, plan, definitionChanges) {
    const U = G.AtriumUndoStore, previous = binding.stamp;
    if (!previous) { cold(binding, plan); return null; }
    const rootVersion = next.versions.get(binding.root);
    if (rootVersion.floor !== previous.versions.get(binding.root)?.floor) {
      cold(binding, plan);
      return null;
    }
    const broadChange = plan !== binding.activePlan || [...next.versions].some(([doc, v]) => {
      const old = previous.versions.get(doc);
      return !old || old.outer !== v.outer || old.project !== v.project || old.parameters !== v.parameters;
    });
    if (broadChange) {
      const old = binding.rows;
      cold(binding, plan);
      return allRowsChanged(old, binding.rows);
    }
    const deltas = [];
    for (const group of binding.groups.values()) {
      const {doc, rows, input} = group, old = previous.versions.get(doc), v = next.versions.get(doc);
      const itemsChanged = v?.items !== old?.items;
      const ordered = itemsChanged ? U.orderedItemChanges(doc, old?.seq, id => rows.has(id)) : null;
      const journal = itemsChanged && !ordered ? U.recordedChanges(doc, old?.seq) : null;
      const delta = ordered || (journal?.ids && {change: journal, append: [], reorder: true});
      if (itemsChanged && !delta) {
        cold(binding, plan);
        return null;
      }
      const mayChangeLayers = delta && [...delta.change.ids].some(id => {
        const a = rows.get(id)?.item, b = delta.change.items.get(id);
        return ["kind", "layer", "fromLayer", "toLayer", "def"].some(key => a?.[key] !== b?.[key]);
      }) || v?.pours !== old?.pours || definitionChanges?.size && [...definitionChanges].some(id => group.byDefinition.has(id));
      if (mayChangeLayers && JSON.stringify(material().layers(input.doc, binding.project)) !== JSON.stringify(group.geometry.layers)) {
        const oldRows = binding.rows;
        cold(binding, plan);
        return allRowsChanged(oldRows, binding.rows);
      }
      deltas.push({group, delta});
    }
    const changed = new Map();
    for (const {group, delta} of deltas) {
      const {doc, rows, input} = group, old = previous.versions.get(doc), v = next.versions.get(doc);
      if (v?.pours !== old?.pours || !input.panelProfile && (v?.items !== old?.items || definitionChanges?.size) &&
          (group.geometry.copper || group.geometry.copperProblem || input.doc.pcbDrawing?.pours?.length)) {
        const {doc: authored, instancePath, transform, panelProfile} = input;
        const nextBoard = rowFor(sourceBoard(binding.project, authored, binding, transform, instancePath, panelProfile), null);
        remember(changed, group.board, nextBoard);
        group.board = nextBoard;
        binding.rows.set(ownerKey(nextBoard.owner), nextBoard);
      }
      if (definitionChanges?.size) {
        group.geometry = {...group.geometry, defs: binding.defs};
        for (const id of definitionChanges) for (const itemId of group.byDefinition.get(id) || []) {
          const before = rows.get(itemId), after = rowFor(group.geometry, before.item);
          rows.set(itemId, after);
          binding.rows.set(ownerKey(after.owner), after);
          remember(changed, before, after);
        }
      }
      if (!delta) continue;
      const {change, append, reorder} = delta;
      for (const id of change.ids) {
        const before = group.rows.get(id), item = change.items.get(id);
        if (before) {
          const key = ownerKey(before.owner);
          group.byDefinition.get(before.item.def)?.delete(id);
          if (!item) {
            remember(changed, before, undefined);
            binding.rows.delete(key);
            group.rows.delete(id);
          } else {
            const row = rowFor(group.geometry, item);
            binding.rows.set(key, row);
            indexItem(group, row);
            if (samePolygonGeometry(before.item, row.item)) row.result = before.result;
            else remember(changed, before, row);
          }
        } else if (reorder && item) {
          const row = rowFor(group.geometry, item);
          indexItem(group, row);
          remember(changed, undefined, row);
        }
      }
      for (const item of append) {
        const row = rowFor(group.geometry, item);
        indexItem(group, row);
        remember(changed, undefined, row);
      }
      if (reorder) {
        // A genuine Undo can reinsert a deleted item in the middle. The journal
        // still owns membership. Only the order index needs to follow the document.
        group.rows = new Map(group.doc.items.map(item => [item.id, group.rows.get(item.id)]));
      }
      if (append.length || reorder) binding.reorder = true;
    }
    if (binding.reorder) {
      binding.rows = indexRows(binding.groups);
      binding.reorder = false;
    }
    return changed;
  }

  function revision(binding, kind) {
    const token = Object.freeze({projectId: binding.project.id, rootId: binding.root.id, kind, generation: String(++generation)});
    lineage.set(token, binding);
    return token;
  }
  function* changedFeatures(before, after) {
    const left = new Map(before.map(feature => [featureKey(feature.key), feature]));
    const right = new Map(after.map(feature => [featureKey(feature.key), feature]));
    for (const id of new Set([...left.keys(), ...right.keys()])) {
      const was = left.get(id), next = right.get(id);
      if (JSON.stringify(was) !== JSON.stringify(next)) { if (was) yield was; if (next) yield next; }
    }
  }
  const noRegions = Object.freeze([]);
  function sameCopperInk(a, b) {
    const left = a.arcs || noRegions, right = b.arcs || noRegions;
    return a.layer === b.layer && (a.net || null) === (b.net || null) &&
      a.count === b.count && a.data === b.data &&
      (left === right || Array.isArray(left) && Array.isArray(right) && same(left, right));
  }
  function copperBounds(pour) {
    if (pour.arcs?.length) {
      const ink = copperInk(pour);
      return ink && inkBounds(ink);
    }
    // Straight copper uses every point in the outer ring. Read the decoded
    // coordinates directly, avoiding a temporary feature and edges for damage.
    const outer = module("AtriumPCBPours").contours(pour)[0];
    if (!outer?.length) return null;
    const box = boxOf();
    for (let i = 0; i < outer.length; i += 2) {
      box[0] = Math.min(box[0], outer[i]); box[1] = Math.min(box[1], outer[i + 1]);
      box[2] = Math.max(box[2], outer[i]); box[3] = Math.max(box[3], outer[i + 1]);
    }
    return box;
  }
  function boardDamage(before, after, note) {
    const a = before.geometry, b = after.geometry;
    // Only plain board rows have precisely the outline and the archived
    // copper below. Panel profile and transformed damage use resolved ink.
    if (!a.transform && !b.transform && !a.panelProfile && !b.panelProfile &&
        JSON.stringify(a.doc.outline) === JSON.stringify(b.doc.outline) &&
        JSON.stringify(a.doc.boardShape) === JSON.stringify(b.doc.boardShape)) {
      const prior = a.copper?.regions || noRegions, next = b.copper?.regions || noRegions;
      if (prior.length === next.length && prior.every((pour, index) => sameCopperInk(pour, next[index]))) return;
      // A freshness transition can remove or restore the entire archive.
      // The damage needs its exact outer bounds, not the resolved features.
      if (!prior.length || !next.length) {
        const row = prior.length ? before : after;
        for (const pour of row.geometry.copper.regions) {
          const box = copperBounds(pour);
          if (box) note(pour.layer, bounded(box, row.owner));
        }
        return;
      }
    }
    for (const feature of changedFeatures(resolved(before).value.features, resolved(after).value.features))
      note(feature.key.layer, feature.bounds);
  }
  function dirty(rows, boards = []) {
    const owners = new Map(), layers = new Set(), bounds = new Map();
    const noteBounds = box => { if (box) bounds.set(box.join(","), box); };
    for (const row of rows) {
      const result = resolved(row);
      owners.set(ownerKey(row.owner), row.owner);
      for (const layer of result.layers) layers.add(layer);
      noteBounds(result.bounds);
    }
    for (const [before, after] of boards) {
      // Profile, imported copper and solved pours share a board owner. Preserve the
      // layers and extent of each unchanged feature during a copper publication.
      owners.set(ownerKey(after.owner), after.owner);
      boardDamage(before, after, (layer, box) => { layers.add(layer); noteBounds(box); });
    }
    return immutable({kind: "incremental", owners: [...owners.values()], layers: [...layers], bounds: [...bounds.values()]});
  }
  function mayBeOnLayer(row, layer) {
    const {item, geometry} = row;
    if (!layer) return true;
    const placed = face => geometry.transform?.layer(face) ?? face;
    if (!item) return layer === "Outline" || geometry.copper?.regions.some(pour => placed(pour.layer) === layer);
    if (item.kind === "track" || item.kind === "graphic" && !item.dimension) {
      const face = item.layer || "Top";
      return placed(face) === layer || module("AtriumPCBAppearance").traceOpenings(item, face)
        .some(film => placed(film.layer) === layer);
    }
    if (item.kind === "label") return placed(module("AtriumPCBAppearance").boardLayer(item)) === layer;
    return true;
  }

  function makeView(binding, token, assertCurrent, getRows, changes) {
    const loneBoard = binding.detached && binding.root.kind === "pcb" ? binding.groups.values().next().value : null;
    const lookup = binding.detached ? key => {
      const group = loneBoard ? (key.documentId === loneBoard.doc.id && key.instancePath.length === 0 ? loneBoard : null)
        : binding.groups.get(occurrenceKey(key));
      return key.kind === "item" ? group?.rows.get(key.id) : key.kind === "board" ? group?.board : undefined;
    } : key => getRows().get(ownerKey(key));
    const rows = binding.detached ? () => orderedRows(binding.groups) : () => getRows().values();
    const deltas = new WeakMap();
    const iterable = build => ({
      [Symbol.iterator]() {
        assertCurrent();
        const source = build();
        return {[Symbol.iterator]() { return this; }, next() { assertCurrent(); return source.next(); }};
      }
    });
    function* features({layer, bounds} = {}) {
      for (const row of rows()) {
        if (!mayBeOnLayer(row, layer) || bounds && row.result?.bounds && !intersects(row.result.bounds, bounds)) continue;
        const result = resolved(row);
        for (const feature of result.value.features)
          if ((!layer || feature.key.layer === layer) && (!bounds || intersects(feature.bounds, bounds))) yield feature;
      }
    }
    function* bores({crossesLayer, bounds} = {}) {
      const layer = crossesLayer && binding.layers.find(row => row.name === crossesLayer);
      if (crossesLayer && !layer) return;
      for (const row of rows()) for (const {bore, bounds: b} of resolveDrilling(row).bores)
        if ((!layer || material().overlapsZ(bore.z, layer.z)) && (!bounds || intersects(bounds, b))) yield bore;
    }
    const drillDiagnostics = () => iterable(function* () {
      for (const row of rows()) yield* resolveDrilling(row).diagnostics;
    });
    const view = Object.freeze({
      get revision() { assertCurrent(); return token; },
      get layers() { assertCurrent(); return binding.layers; },
      assertCurrent,
      changes(since) {
        assertCurrent();
        if (since === token) return dirty([]);
        if (!since || typeof since !== "object") return {kind:"cold"};
        let delta = deltas.get(since);
        if (!delta) deltas.set(since, delta = changes(since));
        return delta;
      },
      owner(key) { assertCurrent(); const row = lookup(key); return row ? resolved(row).value : undefined; },
      diagnostics() { assertCurrent(); return iterable(function* () { for (const row of rows()) yield* resolved(row).diagnostics; }); },
      features(filter) { assertCurrent(); return iterable(() => features(filter)); },
      bores(filter) { assertCurrent(); return iterable(() => bores(filter)); },
      area(key, stage) {
        assertCurrent();
        const row = lookup(key.owner), result = row && resolved(row);
        const feature = result?.keys ? result.keys.get(featureKey(key)) :
          result?.value.features.find(feature => sameFeature(feature.key, key));
        if (!feature) return Object.freeze([]);
        const drill = stage === "finished" ? [...bores({crossesLayer: key.layer, bounds: feature.bounds})] : [];
        return immutable(material().featureArea(feature, drill, stage, binding));
      },
      layerArea(layer, stage, bounds, z) {
        assertCurrent();
        if (binding.detached && binding.layers.some(occupied => occupied.name === layer && occupied.kind === "copper")) {
          const unready = [...binding.groups.values()].find(group => group.board.geometry.copperProblem);
          if (unready) throw Error("Settle copper before composing a detached copper layer (" + unready.board.geometry.copperProblem + ")");
        }
        const drill = stage === "finished" ? [...bores({bounds})] : [];
        const artwork = [...features({layer, bounds})].filter(feature => feature.key.role !== "keepout");
        return immutable(material().layerArea(artwork, drill, layer, stage, bounds, z, binding));
      }
    });
    views.set(view, {binding, token, getRows, lookup, assertCurrent, drillDiagnostics});
    return view;
  }
  // Output options produce parallel views of the same committed inputs. Compare
  // only film/by-face treatments and keep the physical copper owners out of this delta.
  function filmChanges(binding, since) {
    const old = lineage.get(since);
    if (!old || since !== old.token || old.project !== binding.project || old.root !== binding.root ||
        !old.stamp || !same(old.stamp.key, binding.stamp.key)) return {kind: "cold"};
    const altered = key => old.defaults[key] !== binding.defaults[key];
    const mask = ["maskExpansion", "overrideExpansions", "tentVias", "tentTop", "tentBottom"].some(altered);
    const paste = ["pasteExpansion", "overrideExpansions"].some(altered);
    const owners = [], layers = new Set(), bounds = new Map();
    const relevant = feature => mask && feature.key.role === "mask" || paste && feature.key.role === "paste";
    for (const [key, current] of binding.rows) {
      if (!["part", "pad", "via"].includes(current.item?.kind)) continue;
      const before = old.rows.get(key), a = resolved(before), b = resolved(current);
      const left = a.value.features.filter(relevant), right = b.value.features.filter(relevant);
      const treatment = mask && JSON.stringify(a.value.bores.map(bore => bore.treatment)) !==
        JSON.stringify(b.value.bores.map(bore => bore.treatment));
      let ownerChanged = treatment;
      for (const feature of changedFeatures(left, right)) {
        ownerChanged = true;
        layers.add(feature.key.layer);
        bounds.set(feature.bounds.join(","), feature.bounds);
      }
      if (!ownerChanged) continue;
      owners.push(current.owner);
      if (treatment) for (const entry of b.bores) bounds.set(entry.bounds.join(","), entry.bounds);
    }
    return immutable({kind:"incremental", owners, layers:[...layers], bounds:[...bounds.values()]});
  }
  function validateSource(project, root) {
    if (!project?.documents?.includes(root) || root.kind !== "pcb" && root.kind !== "panel")
      throw TypeError("Geometry requires a PCB or panel in the supplied project");
  }
  function captureDefinitions(binding) {
    const versions = new Map(), defs = new Map(), changed = new Set(binding.defs?.keys());
    const U = G.AtriumUndoStore;
    for (const def of binding.project.library) {
      const version = U?.definitionVersion?.(def) ?? 0, prior = binding.definitionSources?.get(def.id);
      const unchanged = prior?.def === def && prior.version === version;
      versions.set(def.id, {def, version});
      defs.set(def.id, unchanged ? binding.defs.get(def.id) : clone(def));
      if (unchanged) changed.delete(def.id);
      else changed.add(def.id);
    }
    binding.definitionSources = versions;
    binding.defs = defs;
    return changed;
  }

  function read(source, values, outputRegions) {
    const {kind, project, root} = source, defaults = defaultsOf(values);
    validateSource(project, root);
    if (kind === "snapshot") {
      if (liveDrag(project) || requiresRuleQuery(project, root)) throw stale();
      if (!source.revision || source.revision.kind === "preview" || source.revision.projectId !== project.id ||
          source.revision.rootId !== root.id || typeof source.revision.generation !== "string")
        throw stale();
      const current = lineage.get(source.revision);
      if ((!current && source.revision.kind !== "snapshot") ||
          (current && (current.project !== project || current.root !== root || current.token !== source.revision))) throw stale();
      current?.view?.assertCurrent();
      const copy = clone(project), snapshot = copy.documents.find(doc => doc.id === root.id);
      const defs = new Map(copy.library.map(def => [def.id, def]));
      const binding = {project: copy, root: snapshot, defs, defaults, detached: true, preview: 0, inputProject: project, outputRegions: outputRegions && clone(outputRegions)};
      cold(binding, pathPlan(binding));
      delete binding.inputProject;
      const token = binding.token = revision(binding, "snapshot");
      return binding.view = makeView(binding, token, () => {}, () => binding.rows ??= indexRows(binding.groups), () => ({kind: "cold"}));
    }
    if (kind !== "editor") throw TypeError("Invalid geometry source");
    let roots = bindings.get(project);
    if (!roots) bindings.set(project, roots = new WeakMap());
    let options = roots.get(root);
    if (!options) roots.set(root, options = new Map());
    const defaultKey = JSON.stringify(defaults);
    let binding = options.get(defaultKey);
    if (!binding) {
      if (options.size >= 8) options.delete(options.keys().next().value);
      options.set(defaultKey, binding = {project, root, defaults, sources: [], history: [], preview: 0});
    }
    const known = stamp(project, root, binding.sources);
    if (!known) throw stale();
    if (binding.stamp && same(known.key, binding.stamp.key)) return binding.view;
    if (liveDrag(project) || requiresRuleQuery(project, root)) throw stale();
    const rootVersion = known.versions.get(root), lastVersion = binding.stamp?.versions.get(root);
    const definitionChanges = !binding.defs || rootVersion.library !== lastVersion?.library || rootVersion.floor !== lastVersion?.floor ?
      captureDefinitions(binding) : null;
    if (!binding.plan || root.kind === "panel" &&
        [...known.versions].some(([doc, next]) => changedPlacement(doc, binding.stamp?.versions.get(doc), next)))
      binding.plan = pathPlan(binding);
    binding.sources = [...new Set(binding.plan.map(p => p.realDoc || p.doc))].filter(doc => doc !== root);
    const next = stamp(project, root, binding.sources);
    if (!next) throw stale();
    const edited = advance(binding, next, binding.plan, definitionChanges);
    const previous = binding.token;
    binding.stamp = next;
    const token = binding.token = revision(binding, "committed");
    if (!edited) binding.history.length = 0;
    else {
      binding.history.push({previous, owners: edited});
      if (binding.history.length > historyLimit) binding.history.shift();
    }
    const assertCurrent = () => {
      const v = stamp(project, root, binding.sources);
      if (binding.token !== token || !v || !same(next.key, v.key)) throw stale();
    };
    binding.view = makeView(binding, token, assertCurrent, () => binding.rows, since => {
      const index = binding.history.findIndex(entry => entry.previous === since);
      return index < 0 ? filmChanges(binding, since) : journalChanges(binding.history, index);
    });
    return binding.view;
  }

  function overlayRows(base, entries) {
    return {
      get(key) { return entries.has(key) ? entries.get(key) : base.get(key); },
      *[Symbol.iterator]() {
        const appended = new Map(entries);
        for (const [key, row] of base) {
          const current = this.get(key);
          appended.delete(key);
          if (current) yield [key, current];
        }
        for (const pair of appended) if (pair[1]) yield pair;
      },
      *values() { for (const [, row] of this) yield row; }
    };
  }
  function preview(base, edits) {
    const parent = views.get(base);
    if (!parent) throw TypeError("Unknown resolved geometry view");
    parent.assertCurrent();
    const {binding: original} = parent, binding = {...original, detached: false};
    const beforeRows = parent.getRows(), replace = new Map(), definitions = new Set();
    let fromRows = beforeRows;
    for (const edit of edits) {
      if (edit.kind !== "definition") continue;
      if (!definitions.size) binding.defs = new Map(original.defs);
      definitions.add(edit.id);
      if (edit.value) binding.defs.set(edit.id, clone(edit.value));
      else binding.defs.delete(edit.id);
    }
    for (const edit of edits) {
      if (edit.kind !== "board") continue;
      const occurrence = occurrenceKey(edit.owner), group = binding.groups.get(occurrence);
      if (!group || edit.owner.kind !== "board" || edit.value.id !== group.doc.id || edit.value.kind !== group.doc.kind)
        throw TypeError("Invalid preview board owner");
      const incoming = clone(edit.value);
      const documents = binding.project.documents.map(doc => doc === group.doc ? incoming : doc);
      const boardProject = {...binding.project, documents};
      if (binding.root === group.doc) {
        binding.root = incoming;
        binding.project = boardProject;
        cold(binding, pathPlan(binding));
        fromRows = binding.rows;
        for (const [key] of beforeRows) replace.set(key, fromRows.get(key));
        for (const [key, row] of fromRows) replace.set(key, row);
      } else {
        const {input} = group, layers = binding.layers;
        const stage = {...binding, project: boardProject};
        cold(stage, [{...input, doc: incoming}]);
        const replacement = stage.groups.get(occurrence);
        for (const row of [group.board, ...group.rows.values()]) replace.set(ownerKey(row.owner), undefined);
        for (const [key, row] of stage.rows) replace.set(key, row);
        binding.groups = new Map(binding.groups).set(occurrence, replacement);
        binding.layers = layers;
      }
    }
    const rows = overlayRows(fromRows, replace);
    if (definitions.size) for (const [key, row] of rows) if (definitions.has(row.item?.def))
      replace.set(key, rowFor({...row.geometry, defs: binding.defs}, row.item));
    for (const edit of edits) {
      if (edit.kind !== "item") continue;
      const group = binding.groups.get(occurrenceKey(edit.owner));
      if (!group || edit.owner.kind !== "item" || edit.value && edit.value.id !== edit.owner.id)
        throw TypeError("Invalid preview item owner");
      replace.set(ownerKey(edit.owner), edit.value ? rowFor({...group.geometry, defs: binding.defs}, edit.value) : undefined);
    }
    const changed = [];
    for (const [key, row] of replace) {
      const before = beforeRows.get(key);
      if (before) changed.push(before);
      if (row) changed.push(row);
    }
    const ticket = ++original.preview, token = revision(binding, "preview");
    const assertCurrent = () => {
      parent.assertCurrent();
      if (original.preview !== ticket) throw stale();
    };
    return makeView(binding, token, assertCurrent, () => rows, since => since === parent.token ? dirty(changed) : {kind: "cold"});
  }

  function requiresRuleQuery(project, root) {
    const L = G.AtriumLazy, R = G.AtriumRules;
    if (!L || !R || G.AtriumDesignQuery && G.AtriumQueryExchange) return false;
    let scratch = [root];
    if (root.kind === "panel") {
      const panel = module("AtriumPanel").normalize(root.panel);
      const ids = new Set([panel.board, ...Object.values(panel.cells).filter(cell => !cell.skip).map(cell => cell.board)]);
      scratch = project.documents.filter(doc => doc.kind === "pcb" && (ids.has(doc.id) || ids.has(doc.name)));
    }
    return scratch.some(doc => L.needsRuleQuery(R.stored(doc, project), "pcb"));
  }

  function authoredRow(view, item, documentId, instancePath = []) {
    const state = views.get(view);
    if (!state) throw TypeError("Unknown resolved geometry view");
    state.assertCurrent();
    const collision = state.binding.collisions?.get(documentId), alias = collision?.aliases.get(item);
    const ambiguous = (collision?.counts.get(item.id) || 0) > 1;
    if (ambiguous && !alias) throw Error("Use the actual authored object to resolve an ambiguous item ID");
    const row = state.lookup({kind:"item", documentId, instancePath, id:alias || item.id});
    return {row, ambiguous, detached:state.binding.detached};
  }

  G.AtriumGeometryReceipts = Object.freeze({
    requiresRuleQuery,
    outputSnapshot(project, root, defaults, regions) {
      const revision = {kind:"snapshot", projectId:project.id, rootId:root.id, generation:"step"};
      return read({kind:"snapshot", project, root, revision}, defaults, regions);
    },
    drillDiagnostics(view) { return views.get(view)?.drillDiagnostics(); },
    itemOwner(view, item, documentId, instancePath) {
      const {row, ambiguous} = authoredRow(view, item, documentId, instancePath);
      return row ? {owner:row.owner, ambiguous} : null;
    },
    // Manufacturing walks authored tracks and graphics once in plot order. Keep
    // the same feature validation, without retaining an unused owner summary.
    itemArtwork(view, item, documentId) {
      const {row, ambiguous, detached} = authoredRow(view, item, documentId);
      if (!detached || !row || row.item.kind !== "track" && row.item.kind !== "graphic")
        throw TypeError("Expected detached track or graphic artwork");
      return {features:resolved(row, true), ambiguous};
    },
    ownerBounds(view, owner) {
      const state = views.get(view);
      if (!state) throw TypeError("Unknown resolved geometry view");
      state.assertCurrent();
      const row = state.lookup(owner);
      return row ? resolved(row).bounds : null;
    }
  });

  function readEditor(project, root, defaults) {
    if ((root?.kind !== "pcb" && root?.kind !== "panel") || !project.documents.includes(root)) return null;
    try { return read({kind: "editor", project, root}, defaults); }
    catch (error) { if (error.code === "STALE_GEOMETRY") return null; throw error; }
  }

  async function prepareEditor(host, project, root, defaults) {
    const current = () => host.project() === project && project.documents.includes(root);
    if (!current()) return null;
    const services = ["AtriumUndoStore"];
    if (root.kind === "panel") services.push("AtriumPanel");
    const [journal] = await G.AtriumLazy.need(services);
    if (!current()) return null;
    if (requiresRuleQuery(project, root)) {
      await G.AtriumLazy.need(["AtriumDesignQuery", "AtriumQueryExchange"]);
      if (!current()) return null;
    }
    // A verified folder already has a receipt. A replacement outside a folder may still have
    // the previous project's Undo baseline until the idle journal catches up.
    if (!host.drag() && !stamp(project, root, [])) journal.sync(project);
    return readEditor(project, root, defaults);
  }

  return Object.freeze({read, preview, readEditor, prepareEditor,
    flatten: (edges, toleranceMm) => curves().flatten(edges, toleranceMm),
    strokeOutline: (stroke, toleranceMm) => curves().strokeOutline(stroke, toleranceMm)
  });
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumResolvedGeometry;
