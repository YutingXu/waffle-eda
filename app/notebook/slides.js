"use strict";

globalThis.AtriumSlides = (() => {
  const G = globalThis, M = G.AtriumFormat2Model, V = G.AtriumSavedViews, L = G.AtriumLinkRecord;
  const limit = M.slideLimit, timerLimit = 24 * 60 * 60 * 1000;
  const clock = () => G.performance?.now() ?? Date.now();
  const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
  const list = project => project.slides ?? [];
  const find = (project, id) => list(project).find(slide => slide.id === id);
  const paper = aspect => aspect === "4:3" ? [720, 540] : [720, 405];

  function describe(slide, documentId, status) {
    const {id, name, source, aspect, notes} = slide;
    return {id, name, source, aspect, documentId, status, hasNotes:!!notes};
  }

  function describeSource(project, slide, refs) {
    const {source} = slide;
    const view = source.kind === "savedView" ? V.find(project, source.savedViewId) : null;
    const documentId = view?.documentId ?? source.documentId ?? null;
    const status = source.kind === "savedView" && !view ?
      "missing-view" : V.documentStatus(V.document(project, documentId, refs));
    return describe(slide, documentId, status);
  }

  function describeMany(project, {offset = 0, limit = 32} = {}, refs) {
    const slides = list(project);
    return {slides:slides.slice(offset, offset + limit).map(slide => describeSource(project, slide, refs)), total:slides.length, offset};
  }

  function framePlan(doc, id, itemIndex) {
    const frame = doc.kind === "schematic" && (itemIndex ? itemIndex().get(id) :
      doc.items.find(item => item.id === id && G.AtriumSchObjects.isFrame(item)));
    if (!frame || !G.AtriumSchObjects.isFrame(frame)) return {status:"missing-frame"};
    const [x, y, right, bottom] = G.AtriumSchObjects.frameBounds(frame), w = right - x, h = bottom - y;
    if (![x, y, right, bottom, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return {status:"invalid-frame"};
    const scale = Math.min(1024 / Math.max(w, h), 1e6);
    const camera = V.camera({cx:x + w / 2, cy:y + h / 2, scale, referenceScale:scale});
    const viewport = {pixelWidth:Math.ceil(w * scale), pixelHeight:Math.ceil(h * scale)};
    return {status:"ready", camera, viewport, selection:[], missingSelection:[], bounds:[x, y, right, bottom]};
  }

  function resolve(project, id, options = {}) {
    const slide = find(project, id);
    if (!slide) return {id, status:"missing-slide"};
    const {source} = slide;
    if (source.kind === "savedView") {
      const scope = V.resolve(project, source.savedViewId, options);
      const finish = ({id:_id, name:_name, documentId = source.documentId ?? null, status, ...plan}) =>
        ({...describe(slide, documentId, status), ...plan});
      return scope?.then ? scope.then(finish) : finish(scope);
    }
    const documentId = source.documentId ?? null;
    const doc = options.doc?.id === documentId ? options.doc : V.document(project, documentId, options.refs);
    const info = describe(slide, documentId, V.documentStatus(doc));
    return Array.isArray(doc?.items) ? {...info, ...framePlan(doc, source.frameId, options.itemIndex)} : info;
  }

  function validateSource(project, source, refs) {
    const sourceDoc = source.kind === "frame" ? source.documentId : V.find(project, source.savedViewId)?.documentId;
    if (!sourceDoc) fail("missing_view", "Choose a saved view in this project.");
    const doc = V.document(project, sourceDoc, refs);
    if (V.documentStatus(doc) === "missing-document") fail("missing_document", "Choose a document in this project.");
    if (source.kind === "frame") {
      if (!Array.isArray(doc.items)) fail("loading_document", "Open the frame's schematic before adding it.");
      if (framePlan(doc, source.frameId).status !== "ready") fail("missing_frame", "Choose an available schematic frame.");
    }
  }

  function edit(project, after, result) {
    return {result, ops:[{op:"set", target:"project", path:["slides"],
      ...(Object.hasOwn(project, "slides") ? {before:list(project)} : {}), after}]};
  }

  function add(project, input, refs) {
    const slides = list(project);
    if (slides.length === limit) fail("slide_limit", "This project already has the maximum number of slides.");
    const {name, aspect = "16:9", notes = "", source} = input;
    const slide = M.checkSlide({id:G.AtriumUUID.next(), name:name.trim(), aspect, notes, source});
    validateSource(project, source, refs);
    return edit(project, [...slides, slide], {slide});
  }

  function existing(project, id) {
    const slide = find(project, id);
    if (!slide) fail("missing_slide", "This slide is no longer available.");
    return slide;
  }

  function update(project, {id, ...changes}, refs) {
    const old = existing(project, id);
    const slide = M.checkSlide({...old, ...changes, name:(changes.name ?? old.name).trim()}, id, {reading:changes.source === undefined});
    if (changes.source) validateSource(project, changes.source, refs);
    if (G.AtriumFormat2.canonical(slide) === G.AtriumFormat2.canonical(old)) return {result:{slide}, ops:[]};
    return edit(project, list(project).map(value => value.id === id ? slide : value), {slide});
  }

  function remove(project, id) {
    existing(project, id);
    return edit(project, list(project).filter(value => value.id !== id), {id});
  }

  function sequence(project, input) {
    const ids = input ?? list(project).map(slide => slide.id);
    if (ids.length > limit || new Set(ids).size !== ids.length || !ids.every(id => L.id(id)))
      fail("invalid_slides", "Choose distinct slides in presentation order.");
    return [...ids];
  }

  function reorder(project, input) {
    const ids = sequence(project, input), old = list(project);
    const entries = new Map(old.map(slide => [slide.id, slide]));
    if (ids.length !== old.length || !ids.every(id => entries.has(id)))
      fail("invalid_slides", "Include each slide in the project exactly once.");
    if (ids.every((id, index) => id === old[index].id)) return {result:{ids}, ops:[]};
    return edit(project, ids.map(id => entries.get(id)), {ids});
  }

  function start(project, {ids, index = 0}, old, prior, now = clock()) {
    ids = sequence(project, ids);
    for (const id of ids) existing(project, id);
    if (!ids.length) return null;
    return {projectId:project.id, ids, index:Math.min(index, ids.length - 1), prior:old ? old.prior : prior,
      startedAtMs:now};
  }

  function advance(deck, {index, direction = 1}) {
    return {...deck, index:Math.max(0, Math.min(deck.ids.length - 1, index ?? deck.index + direction))};
  }

  function presenter(project, deck, now = clock(), refs) {
    if (!deck) return {status:list(project).length ? "inactive" : "empty", index:null, total:0, current:null,
      next:null, notes:"", elapsedMs:0, canGoPrevious:false, canGoNext:false};
    const entry = index => {
      const id = deck.ids[index];
      if (!id) return null;
      const slide = find(project, id);
      return slide ? describeSource(project, slide, refs) : {id, status:"missing-slide"};
    };
    const {index, ids} = deck, current = entry(index), next = entry(index + 1);
    if (current.status === "ready" && deck.viewStatus) current.status = deck.viewStatus;
    return {status:current.status, index, total:ids.length, current, next, notes:find(project, current.id)?.notes ?? "",
      elapsedMs:Math.floor(Math.max(0, Math.min(timerLimit, now - deck.startedAtMs))),
      canGoPrevious:index > 0, canGoNext:index < ids.length - 1};
  }

  function summary(plan) {
    const {filter, missingSelection, ...value} = plan;
    return {...value, ...(missingSelection ? {missingSelectionCount:missingSelection.length} : {}),
      ...(filter ? {filter:{status:filter.status, mask:filter.mask, highlight:filter.highlight}} : {})};
  }

  return Object.freeze({list, find, describeMany, resolve, add, update, remove, sequence, reorder, start, advance, presenter,
    paper, summary, timerLimit});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumSlides;
