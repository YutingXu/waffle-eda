"use strict";

globalThis.__nativeMemory = (() => {
  const mib = 1024 * 1024;
  const expectedCount = 25601;
  const stats = {edits: 0, undos: 0, redos: 0, repours: 0, drcs: 0, autosaves: 0, pans: 0};
  const fixtureState = {docId: null, previousAutosave: null, previousPour: null, pendingDRC: null};
  const h = () => AtriumNavHost;
  const pp = () => AtriumPolygonPour;
  const assert = (test, reason) => { if (!test) throw Error(reason); };
  const position = item => item?.points?.[0][0] ?? item?.x;
  const read = id => h().doc().items.find(item => item.id === id);
  const statsSave = () => AtriumAutosave.stats();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  let started = 0;

  function sample() {
    const host = h(), doc = host.doc(), view = host.view(), undo = AtriumUndoStore.stats();
    const boardView = view.internals();
    const canvas = boardView.cache;
    const gpu = globalThis.AtriumCanvasGPU;
    const gpuStats = gpu?.stats(boardView);
    const pour = pp();
    const save = statsSave();
    return {
      sinceSetupMs: (performance.now() - started),
      received: {...stats},
      docId: doc.id,
      boardItems: doc.items.length,
      webVisibility: document.visibilityState,
      pagePowerVisible: AtriumPower.visible(),
      undo: {bytes: undo.bytes, budget: undo.budget, records: undo.records, branches: undo.branches, shadow: undo.shadow, warm: undo.warm},
      canvas: {indexedItems: canvas?.byId?.size ?? null, boxes: canvas?.boxes?.size ?? null,
        renderWidth: boardView.canvas.width, renderHeight: boardView.canvas.height,
        domCanvases: document.getElementsByTagName("canvas").length, domElements: document.getElementsByTagName("*").length},
      gpu: {route: gpu?.status(boardView)?.renderer ?? null, bytes: gpuStats?.gpuBytes ?? null, itemBytes: gpuStats?.instanceBytes ?? null,
        live: gpuStats?.instances ?? null, dead: gpuStats?.dead ?? null, layers: gpuStats?.layers ?? null, parked: gpuStats?.parked ?? null},
      pours: {regions: doc.pcbDrawing?.pours?.length ?? 0, reuse: pour.reuse.stats.entries,
        tilePatches: pour.tiles.patches.size, liveBusy: pour.live.busy, tileBusy: pour.tiles.busy},
      autosave: {saves: save.saves, bytes: save.bytes, backend: save.backend, pending: save.pending, error: save.error},
      performanceMemoryBytes: Number.isFinite(performance.memory?.usedJSHeapSize) ? performance.memory.usedJSHeapSize : null
    };
  }

  async function setup() {
    document.querySelector('[data-start-action="close"]')?.click();
    await AtriumLazy.need(["AtriumUndoStore", "AtriumPolygonPour"]);
    const {d} = makeAtriumBenchmarkBoard(), project = Atrium.project("Dense PCB memory soak", AtriumParts.catalogue);
    project.documents = [d];
    d.items.push(pp().make([[1, 1], [18, 1], [18, 16], [1, 16]], {id: "soak-pour", layer: "Top", net: "GND", removeDeadCopper: false}));
    await h().replaceProject(project, {force: true});
    h().selectDocument(d.id);
    h().zoomTo([0, 0, 50, 40]);
    pp().live.setMode("manual");
    fixtureState.docId = d.id;
    assert(h().doc().id === d.id && h().doc().items.length === expectedCount, "dense board did not load");
    assert(AtriumUndoStore.stats().budget === 64 * mib, "undo budget differs from shipping default");
    await wait(600);
    started = performance.now();
    return {...sample(), macNativeBridge: typeof AtriumHost.folderAdopt === "function",
      performanceGCObserverSupported: PerformanceObserver.supportedEntryTypes?.includes("gc") === true,
      measureUserAgentSpecificMemorySupport: typeof performance.measureUserAgentSpecificMemory === "function",
      userAgent: navigator.userAgent};
  }

  function housekeeping() {
    const doc = h().doc(), pour = pp();
    if (fixtureState.previousPour != null && pour.reuse.last?.at > fixtureState.previousPour &&
        doc.pcbDrawing?.pours?.some(region => region.polygon === "soak-pour") &&
        pour.current(doc, h().defs(), {project: h().project()})) {
      stats.repours++;
      fixtureState.previousPour = null;
    }
    const status = document.querySelector("#status")?.textContent ?? "";
    if (fixtureState.pendingDRC && globalThis.AtriumMessages?.isOpen() &&
        AtriumMessages.messages().some(message => message.group === "DRC") && /rule violation/.test(status)) {
      stats.drcs++;
      fixtureState.pendingDRC = null;
      AtriumMessages.close();
    }
    if (fixtureState.previousAutosave != null) {
      const auto = statsSave();
      assert(!auto.error, "autosave error: " + auto.error);
      if (auto.saves > fixtureState.previousAutosave) stats.autosaves++;
      fixtureState.previousAutosave = null;
    }
  }

  async function round(index) {
    const host = h(), doc = host.doc(), pour = pp();
    const start = performance.now();
    assert(doc.id === fixtureState.docId && doc.items.length === expectedCount, "active dense board changed");
    housekeeping();
    fixtureState.previousAutosave = statsSave().saves;
    const via = doc.items.find(item => item.kind === "via" && item.x > 1 && item.x < 15 && item.y > 1 && item.y < 12);
    const row = 12 * (index % 7);
    const targets = [via, ...doc.items.slice(row, row + 9)];
    assert(new Set(targets.map(item => item.id)).size === 10, "expected 10 unique edit targets");
    const moves = [];
    for (const [ordinal, item] of targets.entries()) {
      host.select([item.id]);
      const before = position(item);
      const sign = (21 * Math.floor(index / 7) + index + ordinal) % 2 ? -1 : 1;
      const after = ordinal === 0 ? (24 + index % 11) / 10 : Math.round((before + sign * .2) * 100) / 100;
      assert(before !== after, "move must change the coordinate");
      host.edit(() => {
        if (item.points) item.points = item.points.map(([x, y]) => [Math.round((x + after - before) * 1000) / 1000, y]);
        else item.x = after;
      }, "Move " + (item.ref || item.kind), [item]);
      assert(position(read(item.id)) === after, "edit coordinate mismatch for " + item.id);
      moves.push({id: item.id, before, after});
      stats.edits++;
    }
    for (const move of [...moves].reverse()) {
      host.act("undo");
      assert(position(read(move.id)) === move.before, "undo coordinate mismatch for " + move.id);
      stats.undos++;
    }
    for (const move of moves) {
      host.act("redo");
      assert(position(read(move.id)) === move.after, "redo coordinate mismatch for " + move.id);
      stats.redos++;
    }
    const editMs = performance.now() - start;
    host.select([]);
    // One bounded 6 px camera move per round, followed by normal redraw scheduling.
    host.view().pan(index % 2 ? -6 : 6, 0);
    host.redraw();
    stats.pans++;
    if (index % 6 === 1 && fixtureState.previousPour == null) {
      fixtureState.previousPour = pour.reuse.last?.at ?? 0;
      host.act("repour");
    }
    if (index % 6 === 4 && !fixtureState.pendingDRC) {
      fixtureState.pendingDRC = true;
      host.act("drc");
    }
    return {...sample(), editMs, undoChain: moves.length, first: moves[0], last: moves.at(-1)};
  }

  function settledSample() {
    if (fixtureState.previousAutosave != null && statsSave().saves <= fixtureState.previousAutosave) {
      const pending = fixtureState.previousAutosave;
      fixtureState.previousAutosave = null;
      housekeeping();
      fixtureState.previousAutosave = pending;
    } else housekeeping();
    return sample();
  }

  return Object.freeze({setup, round, sample: settledSample});
})();
