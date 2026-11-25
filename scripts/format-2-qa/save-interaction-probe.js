// Appended to desktop-probe.js in the private signed observer.
async function measureSaveInteraction() {
  const board = p.documents.find(doc => doc.kind === "pcb");
  const target = WaffleBaselineEdits.select(p).part;
  check(board && target?.doc === board, "No frozen board move target");
  await h.selectDocument(board.id);
  if (!h.showUnrouted()) h.act("unrouted");
  check(h.showUnrouted() && AtriumPower.visible(), "The board overlay must stay visible");
  await AtriumLazy.need(["AtriumConnectivityLive", "AtriumCamera"]);
  AtriumKeymap.setBindings("camera-pan-right", ["F10"]);
  const canvas = h.canvas(), view = h.view(), definition = h.defs().get(target.item.def);
  canvas.focus();
  const camera = view.camera();
  const states = () => {
    const state = view.internals();
    return {current:state.connectivity?.doc === board && state.connectivity.rev === state.cache?.rev,
      overlayEdges:state.connectivity?.result?.airwires.length ?? 0, revision:state.cache?.rev};
  };
  // The synthetic board has no named copper, hence a correct empty visible overlay can omit a physical graph.
  const hasNets = board.items.some(item => item.net || item.pinNets && Object.values(item.pinNets).some(Boolean));
  const settleOverlay = async () => {
    if (hasNets) await until(() => states().current, "The visible airwire overlay did not catch up", 15000);
  };
  await settleOverlay();
  await frame(); await frame();
  let offset = 0, minRoundTrip = Infinity;
  for (let n = 0; n < 9; n++) {
    const start = clock(), nativeTime = await native("formatClock"), end = clock();
    if (end - start < minRoundTrip) {minRoundTrip = end - start; offset = (end + start) / 2 - nativeTime;}
  }

  let work = null;
  const paint = view.render, live = AtriumConnectivityLive;
  function record(kind, start) {
    if (work) work.push({kind, start, duration:clock() - start, pendingWrites:session.pendingWrites});
  }
  view.render = function (...args) {
    const start = clock();
    try {return paint.apply(this,args);} finally {record("paint",start);}
  };
  globalThis.AtriumConnectivityLive = {...live, deferAirwires(doc, defs, journal, stage, key, ready, publish, started) {
    const instrumented = (phase, id, callback, options) => stage(phase, id, (...args) => {
      const start = clock();
      try {return callback(...args);} finally {record(phase,start);}
    }, options);
    const start = clock();
    try {return live.deferAirwires(doc,defs,journal,instrumented,key,ready,publish,started);}
    finally {record("airwire-dispatch",start);}
  }};

  async function input(mode, index) {
    const type = {pointer:"pointerdown", pan:"wheel", wheel:"wheel", key:"keydown"}[mode];
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + rect.width * .59 + index % 3, y = rect.top + rect.height * .51;
    let event, offFrame;
    const startCamera = view.camera();
    const observation = new Promise((resolve, reject) => {
      function received(e) {
        if (!e.isTrusted || e.target !== canvas && mode !== "key" ||
            mode === "key" && e.key !== "F10" || mode === "pan" && !e.deltaX) return;
        window.removeEventListener(type,received,true);
        event = {handlerAt:clock(),trusted:e.isTrusted,pendingWrites:session.pendingWrites,overlay:states()};
        const presented = moved => {
          offFrame(); offFrame = null;
          const frameAt = clock();
          native("input", {mode:"presentation"}).then(done => resolve({...event,frameAt,presentAt:done.at+offset,moved}),reject);
        };
        if (mode === "pointer") {
          // A click's visual state can change in the inspector without a canvas frame.
          const next = requestAnimationFrame(() => presented(false));
          offFrame = () => cancelAnimationFrame(next);
        } else offFrame = h.on("frame", () => {
          const current = view.camera();
          if (current.cx !== startCamera.cx || current.cy !== startCamera.cy || current.scale !== startCamera.scale) presented(true);
        });
      }
      window.addEventListener(type,received,true);
      offFrame = () => window.removeEventListener(type,received,true);
    });
    try {
      const sent = await native("input", {mode,x,y});
      let result;
      try { result = await bounded(observation, "No trusted " + mode + " presentation", 3500); }
      catch (error) {
        throw Error(error.message + " · " + JSON.stringify({received:!!event, target:document.elementFromPoint(x,y)?.id,
          canvas:canvas.id, active:document.activeElement?.id, tool:h.tool(), pending:session.pendingWrites}));
      }
      const dispatchedAt = sent.at + offset;
      return {...result,dispatchedAt,deliveryMs:result.handlerAt-dispatchedAt,presentedMs:result.presentAt-dispatchedAt};
    } finally {offFrame?.();}
  }

  function sameOverlay() {
    const full = AtriumConnectivity.inspectFull(Atrium.clone(board),h.defs());
    const state = view.internals();
    const shown = states().current ? state.connectivity.result : view.boardConnectivity(board,h.defs());
    const comparable = result => [result.nets,result.airwires,result.shorts,result.excluded,result.unassigned,
      result.stats.objects,result.stats.features,result.sourceNotes];
    return {exact:JSON.stringify(comparable(shown))===JSON.stringify(comparable(full)), edges:shown.airwires.length,
      entities:shown.stats.objects, drawn:states().current || shown.airwires.length===0};
  }
  const rows = [];
  const modes = trial.modes ?? ["pointer","pan","wheel","key"];
  try {
    for (let index = 0; index < (trial.repeats || 4) * modes.length; index++) {
      const mode = modes[index % modes.length];
      if (mode === "key") h.select([]);
      view.restoreCamera(camera); h.redraw();
      await frame(); await frame();
      canvas.focus();
      const idle = await input(mode,index);
      view.restoreCamera(camera); h.redraw();
      await frame(); await frame();

      work = [];
      h.edit(() => Atrium.transformPart(board,target.item,definition,{x:target.item.x+WaffleBaselineEdits.MOVE_MM}),
        "Measured board move", [target.item.id], {documents:[board.id], items:[target.item.id]});
      let cleanSeen;
      const offSave = session.on(kind => {if (kind === "saved" && !h.isDirty()) cleanSeen = clock();});
      const start = clock();
      const saving = h.saveProject();
      let during, saved;
      try {[during,saved] = await Promise.all([input(mode,index+1),saving]);}
      finally {offSave();}
      const nativeOps = await native("formatSaveOps"), phase = at => Number.isFinite(at) ? at+offset-start : null;
      const measured = work.map(entry => ({...entry,start:entry.start-start}));
      work = null;
      check(saved && Number.isFinite(cleanSeen) && !h.isDirty() && session.pendingWrites === 0, "Save did not clean the edited board");
      const receipt = session.metrics().lastSave;
      check(receipt?.rowsEncoded === 1 && receipt.paths.length === 1, "Save affected unrelated records");
      await waitForApply(); await settleOverlay();
      rows.push({mode,idle,during,savedMs:cleanSeen-start,beforeStageMs:phase(nativeOps.stageUptimeMs),
        durableMs:phase(nativeOps.ackUptimeMs),appliedMs:phase(nativeOps.clearUptimeMs), work:measured,after:states()});
    }
    const saved = sameOverlay();
    check(saved.exact && saved.drawn, "The saved airwires differ from a complete calculation");
    const beforeUndo = target.item.x;
    h.act("undo");
    await settleOverlay(); await frame();
    const restored = board.items.find(item => item.id === target.item.id);
    const undo = sameOverlay();
    check(h.isDirty() && restored && restored.x < beforeUndo && undo.exact && undo.drawn, "Undo did not restore exact displayed airwires");
    return {...out, rows, clockBoundMs:1+minRoundTrip/2, overlay:{saved,undo}, pendingWrites:session.pendingWrites};
  } finally {
    view.render = paint;
    globalThis.AtriumConnectivityLive = live;
  }
}
