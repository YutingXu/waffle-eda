"use strict";

// Run with pan-early.js and native-feel.js in the existing AppKit UI harness.
globalThis.__uiProbes = {async run(only, input) {
  try { return "BOARD_FEEL " + JSON.stringify(await realBoardFeel(input)); }
  catch (error) {
    return error.boardFeel ? "JSERROR BOARD_FEEL: " + error.message
      : "JSERROR " + (input.private ? "Native observer failed" : error.stack);
  }
}};

async function realBoardFeel({repetitions, display, hz, shot, dragDiagnostic, legacyDrag, editOnly, private: protectedInput}) {
  const H = AtriumNavHost;
  const post = (op, args = {}) => webkit.messageHandlers.harness.postMessage({op, ...args});
  const pause = ms => new Promise(resolve => window.__rawTimeout(resolve, ms));
  const frame = () => new Promise(requestAnimationFrame);
  const check = (condition, message) => {
    if (!condition) throw Object.assign(Error(message), {boardFeel: true});
  };
  async function until(test, message) {
    const deadline = performance.now() + 8000;
    for (;;) {
      const result = test();
      if (result) return result;
      check(performance.now() < deadline, message);
      await pause(5);
    }
  }
  const capture = await post("feel-state");
  const focused = s => s.displayID === display && s.requestedDisplayMatched !== false && s.appActive && s.windowKey && s.windowVisible &&
    s.orderedOnScreen && s.screenLocked !== true && s.displayHz === hz && s.backingScale === 2;
  await until(() => document.visibilityState === "visible", "Document visibility");
  await post("focusWindow");
  check(focused(await post("feel-state")), "Native window focus or display mismatch at start");
  check(capture.wheelEventBindingSupported !== false, "AppKit wheel binding unavailable");

  const boardRef = () => H.documentRefs().find(doc => doc.kind === "pcb");
  const canvas = () => H.canvas();
  const tab = id => document.querySelector('#document-tabs [data-tab="' + CSS.escape(id) + '"]') ||
    document.querySelector('#documents [data-doc="' + CSS.escape(id) + '"]');
  const pick = el => {
    check(el?.getClientRects().length, "Document tab not visible");
    const r = el.getBoundingClientRect();
    return post("mouse", {x: r.left + r.width / 2, y: r.top + r.height / 2});
  };

  let boardDraw, selectedAt, adoptedAt;
  const offRender = H.addRenderer((doc, options) => {
    if (options.active && doc.id === boardRef()?.id && doc.items.length && !canvas().inert) selectedAt = performance.now();
  });
  const offFrame = H.on("frame", () => { if (selectedAt != null && boardDraw == null) boardDraw = performance.now(); });
  const offReplace = H.on("replace", () => { if (H.folderProject() && adoptedAt == null) adoptedAt = performance.now(); });
  const pointer = [];
  for (const type of ["click", "dblclick", "pointerdown", "pointermove", "pointerup", "pointercancel",
    "gotpointercapture", "lostpointercapture", "keydown"])
    addEventListener(type, e => {
      const target = e.target;
      if (!e.isTrusted) return;
      if (target === canvas() || target.closest?.("[data-tab],[data-doc]") || type === "keydown" || !protectedInput)
        pointer.push({type, at: performance.now(), stamp: e.timeStamp, canvas: target === canvas(), buttons: e.buttons,
          ...(dragDiagnostic && {button: e.button, pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: e.isPrimary}), ...(!protectedInput && {tag: target.tagName, id: target.id, cls: String(target.className), x: e.clientX, y: e.clientY})});
    }, true);

  async function firstBoard() {
    const board = await until(boardRef, "PCB absent after opening folder");
    if (H.doc().id === board.id) return false;
    await pick(await until(() => tab(board.id), "PCB tab absent"));
    return true;
  }
  let openTabToDraw = null;
  if (await firstBoard()) {
    const click = pointer.findLast(e => e.type === "click");
    await until(() => boardDraw != null, "Initial PCB tab has no populated board draw");
    if (click) openTabToDraw = boardDraw - click.stamp;
  }
  await until(() => H.doc().kind === "pcb" && H.doc().items.length, "Initial board inactive");
  const C = await AtriumLazy.need("AtriumCamera");
  const G = await AtriumLazy.need("AtriumCanvasGPU");
  await AtriumLazy.need(["AtriumCanvasInput", "AtriumMotion", "AtriumCanvasFast"]);
  C.setPref("camera.animate", true);
  C.setPref("mouse.wheel", "zoom");

  async function reopen() {
    check(await post("componentHistoryMenu", {action: "close-project"}) === true, "AppKit Close Project unavailable");
    await until(() => !H.folderProject() && document.querySelector("dialog.sp-dialog[open]"), "Close Project did not settle");
    await post("key", {key: "Escape"});
    await until(() => !document.querySelector("dialog.sp-dialog[open]"), "Could not dismiss Home after Close Project");
    await frame();
    boardDraw = null; selectedAt = null; adoptedAt = null; pointer.length = 0;
    const start = performance.now();
    check(await post("componentHistoryReopen") === true, "AppKit reopen unavailable");
    await until(() => adoptedAt != null && H.folderProject(), "Folder adoption missing");
    await until(() => !document.querySelector("dialog.sp-dialog[open]"), "Start Page still covers reopened project");
    const tabClick = await firstBoard();
    await until(() => boardDraw != null, "First populated board draw missing");
    const clicked = pointer.find(e => e.type === "click");
    check(!tabClick || clicked, "PCB tab was not clicked through AppKit");
    return {adoption: adoptedAt - start, firstBoardDraw: boardDraw - start,
      tabClickToDraw: tabClick ? boardDraw - clicked.stamp : null, tabClick};
  }

  const toScreen = (view, xy) => {
    const r = canvas().getBoundingClientRect(), point = view.worldToScreen(xy);
    return [Math.round(r.left + point[0]), Math.round(r.top + point[1])];
  };
  function findEditPoint(view, parts) {
    for (const part of parts.filter(p => H.selectable(p) && !p.locked)) {
      for (const [dx, dy] of [[0, 0], [2, 0], [0, 2], [-2, 0], [0, -2], [5, 0], [0, 5]]) {
        const [x, y] = toScreen(view, [part.x, part.y]), r = canvas().getBoundingClientRect();
        if (x < r.left + 30 || x > r.right - 70 || y < r.top + 30 || y > r.bottom - 70) continue;
        if (H.hit(canvas(), x + dx, y + dy)?.item?.id === part.id) return {part, x: x + dx, y: y + dy};
      }
    }
    check(false, "No visible unlocked footprint suitable for trusted drag");
  }

  function observe(view, partID, movement) {
    const render = view.render, rows = [];
    let previous = view.camera();
    view.render = function (doc, defs, opts) {
      const t = performance.now(), camera = view.camera();
      const sampled = render.call(this, doc, defs, opts);
      const end = performance.now();
      rows.push({t, end, ...(movement && {movement: movement()}), cameraChanged: different(previous, camera), drag: H.editInProgress(),
        revision: H.authoredRevision(), selected: partID ? H.selection().includes(partID) : false, raf: window.__rafTime});
      previous = camera;
      return sampled;
    };
    return {rows, stop: () => { view.render = render; }};
  }
  function cacheState() {
    const c = H.view().internals().cache, store = globalThis.AtriumUndoStore;
    const changes = c && store?.recordedChanges?.(H.doc(), c.seq);
    return {c, data: {count: c?.length, stored: c?.prints?.size, pending: !!c?.preparation,
      sameOwner: c?.doc === H.doc(), journalCount: changes?.ids?.size ?? changes?.ids?.length ?? null,
      deltaKnown: c?.delta?.known ?? null, pendingGeometry: c?.pendingGeometry ?? null}};
  }
  const documentSignature = () => JSON.stringify([H.doc().items, H.doc().netlist, H.doc().nets]);
  async function edit(view, parts) {
    const atEntry = cacheState().data;
    const {part, x, y} = findEditPoint(view, parts);
    await until(() => document.elementFromPoint(x, y) === canvas(), "Canvas covered by a surface");
    const initial = documentSignature(), xy = [part.x, part.y], revision = H.authoredRevision();
    const target = () => H.doc().items.find(it => it.id === part.id);
    const movement = dragDiagnostic ? () => {
      const item = target(), drag = H.drag();
      return {kind: drag?.kind ?? null, previewStarted: !!drag?.before,
        targetChanged: item.x !== xy[0] || item.y !== xy[1],
        samePartSelected: H.selection().includes(part.id)};
    } : null;
    const monitors = observe(view, part.id, movement), {rows} = monitors;
    const before = cacheState(), cacheChanges = [];
    let lastCache = before.c;
    const moveIntent = [], inputErrors = [];
    const onError = e => {
      if (dragDiagnostic && /setPointerCapture|active pointer|invalid pointer/i.test(e.message || ""))
        inputErrors.push(e.error?.name || "pointer capture error");
    };
    addEventListener("error", onError);
    const offIntent = H.on("move-intent", drag => {
      if (dragDiagnostic) moveIntent.push({kind: drag.kind, matchesSelectedPart: drag.item?.id === part.id});
    });
    const offChange = H.on("change", ({source}) => {
      const current = cacheState();
      cacheChanges.push({phase: source === "undo" ? "undo" : "commit", before: current.data,
        previous: lastCache, frame: null});
    });
    const off = H.on("frame", () => {
      const next = cacheChanges.at(-1);
      if (!next || next.frame) return;
      const current = cacheState();
      next.frame = {...current.data, replaced: current.c !== next.previous};
      delete next.previous;
      lastCache = current.c;
    });
    try {
      pointer.length = 0;
      await post("mouse", {x, y});
      const selectInput = pointer.find(e => e.type === "pointerdown" && e.canvas);
      const selectedDraw = rows.find(r => selectInput && r.t >= selectInput.at && r.selected);
      if (!selectInput && !protectedInput)
        await post("note", {text: JSON.stringify({pointer: pointer.slice(-15), target: [x, y],
          expected: canvas().id, actual: document.elementFromPoint(x, y)?.id,
          dialog: document.querySelector("dialog[open]")?.className})});
      check(selectInput, "Trusted component pointer down missing");
      check(H.selection().includes(part.id), "Trusted component selection failed");
      check(selectedDraw, "Selected canvas redraw missing");
      let pickedAfterSelect, diagnostic;
      if (dragDiagnostic) {
        const hit = H.hit(canvas(), x, y)?.item;
        const screen = toScreen(view, [part.x, part.y]);
        const rect = canvas().getBoundingClientRect(), point = view.screenToWorld([x - rect.left, y - rect.top]);
        const labelHit = globalThis.AtriumSchFields?.pick(view, H.doc(), H.defs(), point, {
          hidden: H.hiddenLayers(), layer: H.captureViewState()?.layers?.active, selectable: H.selectable
        });
        pickedAfterSelect = {kind: hit?.kind ?? null, samePart: hit?.id === part.id,
          labelTarget: !!labelHit, labelOwnsSelectedPart: labelHit?.item?.id === part.id,
          screenShiftCSS: [screen[0] - x, screen[1] - y], canvasUnderPointer: document.elementFromPoint(x, y) === canvas(),
          folderEditable: H.folderProject()?.canEdit(H.doc().id) !== false, selectionSize: H.selection().length};
      }
      pointer.length = 0; moveIntent.length = 0;
      const points = Array.from({length: 10}, (_, i) => [x + i * 5, y + i * 2]);
      if (legacyDrag) await post("path", {points, ms: 12});
      else {
        // Use the same AppKit movement and button handling as an ordinary click for
        // the press, then send the paced drag points through the existing path driver.
        await post("mouse", {x, y, kind: "down"});
        await post("path", {points, ms: 12, down: false});
      }
      const moved = () => H.authoredRevision() > revision && (target().x !== xy[0] || target().y !== xy[1]);
      if (dragDiagnostic) {
        await pause(180);
        const pressed = pointer.find(event => event.type === "pointerdown");
        const events = pointer.filter(event => event.canvas)
          .map(({type, at, button, buttons, pointerId, pointerType, isPrimary}) =>
            ({type, elapsedMs: pressed ? at - pressed.at : null, button, buttons, pointerId, pointerType, isPrimary}));
        diagnostic = {selectedKind: part.kind, pickedAfterSelect,
          samePartSelected: H.selection().includes(part.id), changedRevision: H.authoredRevision() !== revision,
          pointerEvents: events, moveIntent, captureErrors: inputErrors, tool: H.tool(), drawStates: rows.map(row => row.movement).filter(Boolean),
          itemsRestored: documentSignature() === initial, cacheAtEntry: atEntry, cacheBefore: before.data,
          cacheChanges: cacheChanges.map(({previous, ...record}) => record)};
        if (!moved()) {
          const native = await post("feel-state");
          return {failed: true, diagnostic: {...diagnostic, nativeFocus: focused(native)}};
        }
      }
      await until(moved, "Trusted drag did not commit a move");
      const moveEnd = pointer.findLast(e => e.type === "pointerup" && e.canvas);
      const dragDown = pointer.find(e => e.type === "pointerdown" && e.canvas);
      const moveBegin = pointer.find(e => e.type === "pointermove" && e.canvas && dragDown && e.at >= dragDown.at);
      const preview = rows.find(r => moveBegin && r.t >= moveBegin.at && r.drag);
      const committed = await until(() => rows.find(r => moveEnd && r.t >= moveEnd.at && r.revision > revision), "Committed board draw missing");
      check(preview, "Trusted drag preview draw missing");
      const movedRevision = H.authoredRevision();
      const undoStart = performance.now();
      if (await post("componentHistoryMenu", {action: "undo"}) !== true) {
        const native = await post("feel-state");
        if (dragDiagnostic) return {failed: true, diagnostic: {...diagnostic, undoAvailable: false, nativeFocus: focused(native)}};
        check(false, "AppKit Undo menu unavailable");
      }
      await until(() => H.authoredRevision() > movedRevision && target()?.x === xy[0] && target()?.y === xy[1], "Undo did not restore component position");
      const undone = await until(() => rows.find(r => r.t >= undoStart && r.revision > movedRevision), "Restored board draw missing");
      check(documentSignature() === initial, "Undo changed board geometry, item order or electrical assignment");
      return {select: selectedDraw.end - selectInput.stamp, dragPreview: preview.end - moveBegin.stamp,
        commit: committed.end - moveEnd.stamp, undo: undone.end - undoStart, restored: true,
        ...(diagnostic && {diagnostic}), cacheAtEntry: atEntry, cacheBefore: before.data, cacheChanges: cacheChanges.map(({previous, ...record}) => record)};
    } finally {
      monitors.stop(); offChange(); off(); offIntent(); removeEventListener("error", onError);
    }
  }

  function range(row) {
    return {...stats(row), atLeast8_33ms: row.filter(t => t >= 1000 / 120).length,
      atLeast16_67ms: row.filter(t => t >= 1000 / 60).length};
  }
  async function gesture(view, kind, [x, y], steps, ms, centre = false, isolated = false) {
    const initialState = await post("feel-state");
    check(focused(initialState), "Native window lost focus before gesture");
    check(document.elementFromPoint(x, y) === canvas(), "Gesture anchor is covered by editor chrome or a dialog");
    const r = canvas().getBoundingClientRect(), start = view.camera(), revision = H.authoredRevision();
    const anchor = centre ? [canvas().clientWidth / 2, canvas().clientHeight / 2] : [x - r.left, y - r.top];
    const world = view.screenToWorld(anchor);
    const monitor = observe(view), {rows} = monitor;
    const ticks = [], notchPackets = [];
    const recordNotches = e => {
      const classified = globalThis.__waffleWheelNotches?.(e);
      if (!classified?.length && !e.deltaY) return;
      notchPackets.push({trusted: e.isTrusted, target: e.target?.id, x: e.clientX, y: e.clientY,
        ctrl: e.ctrlKey, at: performance.now(),
        notches: classified || [{deltaY: e.deltaY, timeStamp: e.timeStamp}]});
    };
    if (kind === "ctrl-line") addEventListener("wheel", recordNotches, {capture: true, passive: true});
    let ticking = !isolated, ackPromise = null;
    const tick = t => { if (ticking) { ticks.push(t); requestAnimationFrame(tick); } };
    if (ticking) requestAnimationFrame(tick);
    const onFrame = isolated ? H.on("frame", () => {
      if (!ackPromise && rows.some(row => row.cameraChanged)) ackPromise = post("feel-ack");
    }) : () => {};
    const uploadedBefore = window.__uploads;
    window.__inputs.length = 0;
    window.__work.length = 0;
    try {
      const sent = await post("feel-input", {kind, x, y, steps, ms});
      if (isolated) await until(() => ackPromise, "Isolated notch had no changed draw");
      // Saturated WebContent can deliver packets after the normal 120 ms motion settles.
      // Wait for evidence without extending the measured active interval.
      await pause(230);
      if (kind === "ctrl-line" && !notchPackets.length) await pause(350);
      ticking = false;
      const events = kind === "pan" ? window.__inputs.filter(changesCamera) :
        notchPackets.flatMap(({notches, ...packet}) => notches.map(step => ({
          ...packet, dy: step.deltaY, stamp: step.timeStamp
        })));
      const changed = rows.filter(row => row.cameraChanged);
      check(sent.length === steps.length && events.length > 0,
        `Missing ${kind} packets (sent ${sent.length}/${steps.length}, effective ${events.length})`);
      if (kind === "ctrl-line") check(events.length === sent.length &&
          events.every((event, index) => event.dy === -40 * sent[index].dy),
        `Signed notch sequence mismatch (native ${sent.length}, DOM ${notchPackets.length}, effective ${events.length})`);
      check(events.every(e => e.trusted && e.target === canvas().id && e.x === x && e.y === y && e.ctrl === (kind === "ctrl-line")),
        "Wheel escaped the requested canvas point or modifier");
      const expected = expectedCamera(kind, "zoom", start, sent, r, anchor);
      const finish = view.camera(), error = Math.max(...Object.keys(expected).map(key => Math.abs(expected[key] - finish[key])));
      const [ax, ay] = view.worldToScreen(world);
      check(error < 1e-6 && H.authoredRevision() === revision, "Navigation failed to converge or altered the board");
      const anchorErrorPx = kind === "pan" ? null : Math.hypot(ax - anchor[0], ay - anchor[1]);
      check(anchorErrorPx == null || anchorErrorPx < .01, "Zoom failed to hold its world anchor");
      const first = events[0], last = events.at(-1), lastDraw = changed.at(-1);
      check(lastDraw, "Navigation produced no changed camera draws");
      const intervals = differences(ticks).filter((dt, i) => ticks[i + 1] >= first.at && ticks[i] <= Math.max(lastDraw.end, last.at));
      const latency = events.map(e => {
        const draw = changed.find(row => row.t >= e.at);
        return draw ? {dom: draw.end - e.at, stamp: draw.end - e.stamp} : null;
      }).filter(Boolean);
      let callbackWork = 0;
      for (let i = 0; i < window.__work.length; i += 2) {
        if (window.__work[i] >= first.at && window.__work[i] <= lastDraw.end) callbackWork += window.__work[i + 1];
      }
      const ack = ackPromise ? await ackPromise : null;
      return {sent: sent.length, arrived: events.length, domPackets: kind === "pan" ? events.length : notchPackets.length,
        draws: rows.length, changedDraws: changed.length,
        convergence: lastDraw.end - last.at, cameraError: error, anchorErrorPx, scaleRatio: finish.scale / start.scale,
        duration: lastDraw.end - first.at, callbackWork, uploadBytes: window.__uploads - uploadedBefore,
        changedDrawIntervals: differences(changed.map(row => row.end)),
        ...(!protectedInput && {inputPoint: [x, y], startCamera: start, settledCamera: finish}),
        drawCPU: rows.map(row => row.end - row.t),
        intervals, latency, ack: ack?.acknowledged ? ack.ms : null};
    } finally {
      ticking = false;
      removeEventListener("wheel", recordNotches, true);
      monitor.stop(); onFrame();
    }
  }

  const runs = [];
  let illustrativeCamera;
  try {
    for (let repeat = 0; repeat < repetitions; repeat++) {
      G.enable(null);
      const entry = await reopen();
      const view = H.view(), doc = H.doc(), parts = doc.items.filter(item => item.kind === "part");
      const rendererAtEntry = G.status(view.internals()).renderer;
      const counts = {items: doc.items.length, parts: parts.length, tracks: doc.items.filter(i => i.kind === "track").length};
      const endState = async () => {
        const state = await post("feel-state");
        check(focused(state), "Native window focus or display mismatch at end");
        const {displayID, displayHz, backingScale, appActive, windowKey, windowVisible} = state;
        return {displayID, displayHz, backingScale, appActive, windowKey, windowVisible};
      };
      check(parts.length > 0, "Real board has no placed parts");
      const editResult = await edit(view, parts);
      if (editResult.failed) return {diagnostic: editResult.diagnostic, completedRuns: runs, repeat, entry, openTabToDraw, restored: false};
      if (editOnly) {
        runs.push({native: await endState(), entry, rendererAtEntry, edit: editResult, counts});
        continue;
      }
      await frame();
      G.enable(true);
      H.redraw(true);
      await until(() => G.status(view.internals()).renderer === "gpu" && G.stats(view.internals())?.submitted, "GPU did not submit board geometry");
      const r = canvas().getBoundingClientRect();
      const viewport = {width: r.width, height: r.height, dpr: devicePixelRatio};
      const targetParts = parts.map(part => {
        const pads = H.defs().get(part.def)?.footprint?.pads?.length || 0, [x, y] = toScreen(view, [part.x, part.y]);
        return {part, pads, x, y};
      }).filter(({x, y}) => x > r.left + 50 && x < r.right - 50 && y > r.top + 50 && y < r.bottom - 50 && document.elementFromPoint(x, y) === canvas())
        .sort((a, b) => b.pads - a.pads);
      const target = targetParts[0];
      check(target?.pads > 0, "No fully visible placed footprint with authored pads");
      C.setPref("mouse.zoomAt", "pointer");
      const zoom = await gesture(view, "ctrl-line", [target.x, target.y], Array.from({length: 5}, () => [0, 1, 0]), 45);
      illustrativeCamera = view.camera();
      const panSteps = Array.from({length: 48}, (_, i) => i === 47 ? [0, 0, 3] : [i < 32 ? 6 : -3, i < 32 ? -4 : 3, i ? 2 : 1]);
      const pan = await gesture(view, "pan", [target.x, target.y], panSteps, 1000 / 120);
      C.setPref("mouse.zoomAt", "centre");
      const wheelSteps = [1, 1, 1, -1, -1, -1, -1, 1, 1, 1, -1, 1, 1].map(dy => [0, dy, 0]);
      const wheel = await gesture(view, "ctrl-line", [target.x, target.y], wheelSteps, 34, true);
      const isolated = [];
      for (const dy of [-1, 1, -1, 1]) isolated.push(await gesture(view, "ctrl-line", [target.x, target.y], [[0, dy, 0]], 30, true, true));
      const idleProbe = observe(view);
      await pause(480);
      const firstIdle = performance.now(), startRenders = idleProbe.rows.length, uploads = window.__uploads, work = window.__work.length;
      const tracksBefore = AtriumMotion.active();
      await pause(400);
      const idle = {ms: performance.now() - firstIdle, renders: idleProbe.rows.length - startRenders,
        wrappedCallbacks: (window.__work.length - work) / 2, uploadBytes: window.__uploads - uploads,
        motionTracks: [tracksBefore, AtriumMotion.active()]};
      idleProbe.stop();
      check(idle.motionTracks.every(value => value === 0), "Board did not return to idle motion");
      runs.push({native: await endState(), entry, viewport, rendererAtEntry, edit: editResult, zoom, pan, wheel, isolated, idle,
        targetPads: target.pads, targetRef: protectedInput ? null : target.part.ref, counts});
    }
    const summary = {entry: {}, edit: {}, gestures: {}};
    for (const key of ["adoption", "firstBoardDraw", "tabClickToDraw"]) summary.entry[key] = stats(runs.map(r => r.entry[key]));
    for (const key of ["select", "dragPreview", "commit", "undo"]) summary.edit[key] = stats(runs.map(r => r.edit[key]));
    for (const key of editOnly ? [] : ["zoom", "pan", "wheel", "isolated"]) {
      const group = runs.flatMap(r => r[key]), values = field => group.flatMap(row => row[field]);
      summary.gestures[key] = {intervals: range(values("intervals")), changedDrawIntervals: range(values("changedDrawIntervals")),
        domToDraw: stats(values("latency").map(row => row.dom)),
        nativeStampToDraw: stats(values("latency").map(row => row.stamp)), drawCPU: stats(values("drawCPU")),
        convergence: stats(values("convergence")), presentationAcknowledgement: stats(values("ack"))};
    }
    // Keep switching documents outside the gesture and idle windows.
    const schematic = H.documentRefs().find(doc => doc.kind === "schematic" && tab(doc.id)?.getClientRects().length);
    let tabSwitch = null;
    if (schematic) {
      await pick(tab(schematic.id));
      await until(() => H.doc().id === schematic.id, "Schematic tab did not activate");
      boardDraw = null; selectedAt = null; pointer.length = 0;
      await firstBoard();
      await until(() => boardDraw != null, "PCB tab return did not draw");
      const input = pointer.find(e => e.type === "click");
      check(input, "PCB tab return was not trusted");
      tabSwitch = boardDraw - input.stamp;
    }
    if (shot && !protectedInput) {
      H.view().restoreCamera(illustrativeCamera);
      H.redraw(true);
      await frame();
      await frame();
      await post("shot", {name: "board-zoom"});
    }
    return {runs, summary, openTabToDraw, tabSwitch, visibilityOverride: true};
  } finally {
    offRender(); offFrame(); offReplace();
  }
}
